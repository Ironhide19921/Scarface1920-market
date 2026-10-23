import { LOW_IDS, HIGH_IDS, idsForCardSet, tierOf } from "./cards-meta.js";

const LOW_SLOTS = 4;
const HIGH_SLOTS = 2;
const CARD_SETS = ["common", "nightdeck", "both"];

const MSG = {
  es: {
    tierMismatch: "Esa carta no corresponde a ese nivel del mercado.",
    notAvailable: "Esa carta no está disponible en esta sala.",
  },
  en: {
    tierMismatch: "That card doesn't belong in that market tier.",
    notAvailable: "That card isn't available in this room.",
  },
};

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class MarketRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Set();
    this.market = null; // { marketLow: [id|null x4], marketHigh: [id|null x2], discard: [id,...] }
    this.lang = null; // "es" | "en" - fixed for the room's lifetime once first dealt
    this.cardSet = null; // "common" | "nightdeck" | "both" - fixed for the room's lifetime
    this._ready = null;
  }

  // The room's language and card set are decided the first time it's ever
  // opened (by whoever creates it) and then persisted, so later joiners with
  // a different client preference get their UI synced to match instead.
  ensureReady(requestedLang, requestedSet) {
    if (!this._ready) {
      this._ready = this.state.blockConcurrencyWhile(async () => {
        const storedMarket = await this.state.storage.get("market");
        const storedLang = await this.state.storage.get("lang");
        const storedSet = await this.state.storage.get("cardSet");
        this.lang = storedLang || requestedLang || "es";
        this.cardSet = storedSet || requestedSet || "common";
        this.market = storedMarket || this.dealInitialMarket();
        if (!storedMarket) await this.state.storage.put("market", this.market);
        if (!storedLang) await this.state.storage.put("lang", this.lang);
        if (!storedSet) await this.state.storage.put("cardSet", this.cardSet);
      });
    }
    return this._ready;
  }

  dealInitialMarket() {
    const idSet = new Set(idsForCardSet(this.cardSet));
    const low = shuffle(LOW_IDS.filter((id) => idSet.has(id)));
    const high = shuffle(HIGH_IDS.filter((id) => idSet.has(id)));
    return {
      marketLow: low.slice(0, LOW_SLOTS),
      marketHigh: high.slice(0, HIGH_SLOTS),
      discard: [],
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const requestedLang = url.searchParams.get("lang") === "en" ? "en" : "es";
    const requestedSetParam = url.searchParams.get("set");
    const requestedSet = CARD_SETS.includes(requestedSetParam) ? requestedSetParam : "common";
    await this.ensureReady(requestedLang, requestedSet);

    if (url.pathname.endsWith("/ws")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleSession(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }

  handleSession(ws) {
    ws.accept();
    this.sockets.add(ws);
    this.send(ws, { type: "state", market: this.market, viewers: this.sockets.size, lang: this.lang, cardSet: this.cardSet });
    this.broadcastViewers();

    ws.addEventListener("message", (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      this.handleMessage(ws, msg);
    });

    const cleanup = () => {
      this.sockets.delete(ws);
      this.broadcastViewers();
    };
    ws.addEventListener("close", cleanup);
    ws.addEventListener("error", cleanup);
  }

  handleMessage(ws, msg) {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "move") {
      this.applyMove(ws, msg.cardId, msg.targetZone, msg.targetIndex);
    } else if (msg.type === "reset") {
      this.applyReset();
    }
  }

  locate(cardId) {
    const li = this.market.marketLow.indexOf(cardId);
    if (li !== -1) return { zone: "marketLow", index: li };
    const hi = this.market.marketHigh.indexOf(cardId);
    if (hi !== -1) return { zone: "marketHigh", index: hi };
    const di = this.market.discard.indexOf(cardId);
    if (di !== -1) return { zone: "discard", index: di };
    if (idsForCardSet(this.cardSet).includes(cardId)) return { zone: "pool", index: -1 };
    return null;
  }

  applyMove(ws, cardId, targetZone, targetIndex) {
    if (!idsForCardSet(this.cardSet).includes(cardId)) {
      this.send(ws, { type: "error", message: MSG[this.lang].notAvailable });
      return;
    }
    const from = this.locate(cardId);
    if (!from) return;

    if ((targetZone === "marketLow" || targetZone === "marketHigh")) {
      const wantTier = targetZone === "marketLow" ? "low" : "high";
      if (tierOf(cardId) !== wantTier) {
        this.send(ws, { type: "error", message: MSG[this.lang].tierMismatch });
        return;
      }
      const arr = this.market[targetZone];
      if (typeof targetIndex !== "number" || targetIndex < 0 || targetIndex >= arr.length) return;
    }

    // remove from current location
    if (from.zone === "marketLow" || from.zone === "marketHigh") {
      this.market[from.zone][from.index] = null;
    } else if (from.zone === "discard") {
      this.market.discard.splice(from.index, 1);
    }
    // pool: nothing to remove, it wasn't tracked anywhere

    // place at destination
    if (targetZone === "marketLow" || targetZone === "marketHigh") {
      this.market[targetZone][targetIndex] = cardId;
    } else if (targetZone === "discard") {
      this.market.discard.push(cardId);
    }
    // targetZone === "pool": nothing to add, implicit

    this.persistAndBroadcast();
  }

  applyReset() {
    for (let i = 0; i < this.market.marketLow.length; i++) {
      if (this.market.marketLow[i]) {
        this.market.discard.push(this.market.marketLow[i]);
        this.market.marketLow[i] = null;
      }
    }
    for (let i = 0; i < this.market.marketHigh.length; i++) {
      if (this.market.marketHigh[i]) {
        this.market.discard.push(this.market.marketHigh[i]);
        this.market.marketHigh[i] = null;
      }
    }
    this.persistAndBroadcast();
  }

  async persistAndBroadcast() {
    await this.state.storage.put("market", this.market);
    this.broadcast({ type: "state", market: this.market, viewers: this.sockets.size, lang: this.lang, cardSet: this.cardSet });
  }

  broadcastViewers() {
    this.broadcast({ type: "viewers", viewers: this.sockets.size });
  }

  send(ws, data) {
    try {
      ws.send(JSON.stringify(data));
    } catch {
      /* socket may be closing */
    }
  }

  broadcast(data) {
    const payload = JSON.stringify(data);
    for (const ws of this.sockets) {
      try {
        ws.send(payload);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }
}
