import { ALL_IDS, LOW_IDS, HIGH_IDS, tierOf } from "./cards-meta.js";

const LOW_SLOTS = 4;
const HIGH_SLOTS = 2;

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
    this.ready = this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get("market");
      this.market = stored || this.dealInitialMarket();
      if (!stored) await this.state.storage.put("market", this.market);
    });
  }

  dealInitialMarket() {
    const low = shuffle(LOW_IDS);
    const high = shuffle(HIGH_IDS);
    return {
      marketLow: low.slice(0, LOW_SLOTS),
      marketHigh: high.slice(0, HIGH_SLOTS),
      discard: [],
    };
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);

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
    this.send(ws, { type: "state", market: this.market, viewers: this.sockets.size });
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

    if ((targetZone === "marketLow" || targetZone === "marketHigh")) {
      const wantTier = targetZone === "marketLow" ? "low" : "high";
      if (tierOf(cardId) !== wantTier) {
        this.send(ws, { type: "error", message: "Esa carta no corresponde a ese nivel del mercado." });
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
    this.broadcast({ type: "state", market: this.market, viewers: this.sockets.size });
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
