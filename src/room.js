import {
  ALL_IDS,
  LOW_IDS,
  HIGH_IDS,
  LOW_IDS_ORIGINAL,
  HIGH_IDS_ORIGINAL,
  tierOf,
  isOriginal,
} from "./cards-meta.js";

const LOW_SLOTS = 4;
const HIGH_SLOTS = 2;

const MSG = {
  es: {
    tierMismatch: "Esa carta no corresponde a ese nivel del mercado.",
    notAvailable: "Esta sala es solo con las 60 cartas originales; esa carta no está disponible.",
  },
  en: {
    tierMismatch: "That card doesn't belong in that market tier.",
    notAvailable: "This room only uses the original 60 cards; that card isn't available.",
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
    this._ready = null;
  }

  // The room's language/card-set is decided the first time it's ever opened
  // (by whoever creates it) and then persisted, so later joiners with a
  // different client preference don't change what cards are in play.
  ensureReady(requestedLang) {
    if (!this._ready) {
      this._ready = this.state.blockConcurrencyWhile(async () => {
        const storedMarket = await this.state.storage.get("market");
        const storedLang = await this.state.storage.get("lang");
        this.lang = storedLang || requestedLang || "es";
        this.market = storedMarket || this.dealInitialMarket(this.lang);

        // Rooms that existed before the language feature (or before this
        // room's lang was ever persisted) may already have a non-original
        // "BB" card sitting in the market/discard from before the English
        // restriction applied. Purge those back to the (implicit) pool so
        // an English room never actually shows one.
        let changed = false;
        if (this.lang === "en") {
          for (const zone of ["marketLow", "marketHigh"]) {
            this.market[zone] = this.market[zone].map((id) => {
              if (id && !isOriginal(id)) {
                changed = true;
                return null;
              }
              return id;
            });
          }
          const cleanDiscard = this.market.discard.filter((id) => isOriginal(id));
          if (cleanDiscard.length !== this.market.discard.length) {
            this.market.discard = cleanDiscard;
            changed = true;
          }
        }

        if (!storedMarket || changed) await this.state.storage.put("market", this.market);
        if (!storedLang) await this.state.storage.put("lang", this.lang);
      });
    }
    return this._ready;
  }

  dealInitialMarket(lang) {
    const low = shuffle(lang === "en" ? LOW_IDS_ORIGINAL : LOW_IDS);
    const high = shuffle(lang === "en" ? HIGH_IDS_ORIGINAL : HIGH_IDS);
    return {
      marketLow: low.slice(0, LOW_SLOTS),
      marketHigh: high.slice(0, HIGH_SLOTS),
      discard: [],
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const requestedLang = url.searchParams.get("lang") === "en" ? "en" : "es";
    await this.ensureReady(requestedLang);

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
    this.send(ws, { type: "state", market: this.market, viewers: this.sockets.size, lang: this.lang });
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
    if (ALL_IDS.includes(cardId)) return { zone: "pool", index: -1 };
    return null;
  }

  applyMove(ws, cardId, targetZone, targetIndex) {
    if (!ALL_IDS.includes(cardId)) return;
    const from = this.locate(cardId);
    if (!from) return;

    const entersTrackedZone = targetZone === "marketLow" || targetZone === "marketHigh" || targetZone === "discard";
    if (this.lang === "en" && entersTrackedZone && !isOriginal(cardId)) {
      this.send(ws, { type: "error", message: MSG.en.notAvailable });
      return;
    }

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
    this.broadcast({ type: "state", market: this.market, viewers: this.sockets.size, lang: this.lang });
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
