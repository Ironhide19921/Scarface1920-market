(() => {
  "use strict";

  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid confusion

  const els = {
    landing: document.getElementById("landing"),
    roomScreen: document.getElementById("roomScreen"),
    btnCreate: document.getElementById("btnCreate"),
    formJoin: document.getElementById("formJoin"),
    inputCode: document.getElementById("inputCode"),
    landingError: document.getElementById("landingError"),

    roomCodeLabel: document.getElementById("roomCodeLabel"),
    btnShowCode: document.getElementById("btnShowCode"),
    connStatus: document.getElementById("connStatus"),
    viewerCount: document.getElementById("viewerCount"),
    btnReset: document.getElementById("btnReset"),

    selectionBanner: document.getElementById("selectionBanner"),
    selectionText: document.getElementById("selectionText"),
    btnCancelSelection: document.getElementById("btnCancelSelection"),

    marketLow: document.getElementById("marketLow"),
    marketHigh: document.getElementById("marketHigh"),

    discardPile: document.getElementById("discardPile"),
    discardCount: document.getElementById("discardCount"),
    discardGrid: document.getElementById("discardGrid"),

    poolGrid: document.getElementById("poolGrid"),
    poolSearch: document.getElementById("poolSearch"),

    zoomModal: document.getElementById("zoomModal"),
    zoomClose: document.getElementById("zoomClose"),
    zoomCardHost: document.getElementById("zoomCardHost"),
    zoomPrev: document.getElementById("zoomPrev"),
    zoomNext: document.getElementById("zoomNext"),

    confirmModal: document.getElementById("confirmModal"),
    confirmText: document.getElementById("confirmText"),
    confirmOk: document.getElementById("confirmOk"),
    confirmCancel: document.getElementById("confirmCancel"),
  };

  let cardsById = {};     // id -> card data (bilingual)
  let marketState = { marketLow: [null, null, null, null], marketHigh: [null, null], discard: [] };
  let selected = null;    // {kind:'card'|'empty', zone, index, cardId?}
  let ws = null;
  let reconnectDelay = 1000;
  let roomCode = null;

  // ---------- Utilities ----------

  function normalize(str) {
    return str.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }

  function randomCode(len = 4) {
    let s = "";
    for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return s;
  }

  function starString(level) {
    return "★".repeat(level);
  }

  function tierOfLevel(level) {
    return level >= 4 ? "high" : "low";
  }

  function flashToast(message) {
    els.selectionText.textContent = message;
    els.selectionBanner.hidden = false;
    els.btnCancelSelection.hidden = true;
    clearTimeout(flashToast._t);
    flashToast._t = setTimeout(() => {
      els.btnCancelSelection.hidden = false;
      renderSelectionBanner();
    }, 1800);
  }

  // ---------- Card data ----------

  async function loadCards() {
    const res = await fetch("data/cards.json");
    const list = await res.json();
    cardsById = {};
    for (const c of list) cardsById[c.id] = c;
  }

  // ---------- Routing ----------

  function getRoomFromUrl() {
    const params = new URLSearchParams(location.search);
    const code = (params.get("room") || "").toUpperCase();
    return /^[A-Z0-9]{4,8}$/.test(code) ? code : null;
  }

  function goToRoom(code) {
    const url = new URL(location.href);
    url.searchParams.set("room", code);
    history.replaceState(null, "", url);
    enterRoom(code);
  }

  // ---------- Landing ----------

  els.btnCreate.addEventListener("click", () => {
    goToRoom(randomCode());
  });

  els.formJoin.addEventListener("submit", (e) => {
    e.preventDefault();
    const code = els.inputCode.value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(code)) {
      els.landingError.textContent = "Ingresa un código válido (4 a 8 letras/números).";
      els.landingError.hidden = false;
      return;
    }
    els.landingError.hidden = true;
    goToRoom(code);
  });

  // ---------- Room entry ----------

  function enterRoom(code) {
    roomCode = code;
    els.landing.hidden = true;
    els.roomScreen.hidden = false;
    els.roomCodeLabel.textContent = code;
    connectWS();
  }

  function connectWS() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/api/room/${roomCode}/ws`);
    setConnStatus("off");

    ws.addEventListener("open", () => {
      setConnStatus("on");
      reconnectDelay = 1000;
    });

    ws.addEventListener("message", (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      handleServerMessage(msg);
    });

    ws.addEventListener("close", scheduleReconnect);
    ws.addEventListener("error", () => setConnStatus("err"));
  }

  function scheduleReconnect() {
    setConnStatus("off");
    setTimeout(connectWS, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 10000);
  }

  function setConnStatus(state) {
    els.connStatus.classList.remove("conn-on", "conn-off", "conn-err");
    els.connStatus.classList.add(`conn-${state}`);
  }

  function handleServerMessage(msg) {
    if (msg.type === "state") {
      marketState = msg.market;
      if (typeof msg.viewers === "number") setViewers(msg.viewers);
      renderAll();
    } else if (msg.type === "viewers") {
      setViewers(msg.viewers);
    } else if (msg.type === "error") {
      flashToast(msg.message || "Movimiento no válido.");
    }
  }

  function setViewers(n) {
    els.viewerCount.textContent = `👥 ${n}`;
  }

  function sendMove(cardId, to) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "move", cardId, targetZone: to.zone, targetIndex: to.index }));
  }

  function sendReset() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "reset" }));
  }

  // ---------- Rendering ----------

  function currentPoolIds() {
    const used = new Set([
      ...marketState.marketLow.filter(Boolean),
      ...marketState.marketHigh.filter(Boolean),
      ...marketState.discard,
    ]);
    return Object.keys(cardsById).filter((id) => !used.has(id));
  }

  function cardThumbEl(cardId, zone, index) {
    const c = cardsById[cardId];
    const tier = tierOfLevel(c.level);
    const div = document.createElement("div");
    div.className = `card-el tier-${tier} selectable`;
    div.dataset.cardid = cardId;
    div.dataset.zone = zone;
    if (index !== undefined) div.dataset.index = index;
    if (isSelectedCard(cardId, zone, index)) div.classList.add("selected");
    div.title = `${c.name.es} (${starString(c.level)})`;
    div.innerHTML = `
      <div class="card-art-wrap"><img src="assets/cards/${cardId}.jpg" alt="${c.name.es}" loading="lazy" /></div>
      <button class="card-zoom-btn" data-zoomid="${cardId}" aria-label="Ver detalle">🔍</button>
    `;
    return div;
  }

  function emptySlotEl(zone, index) {
    const tier = zone === "marketHigh" ? "high" : "low";
    const div = document.createElement("div");
    div.className = `card-slot-empty tier-${tier}`;
    div.dataset.emptyzone = zone;
    div.dataset.emptyindex = index;
    if (isSelectedEmpty(zone, index)) div.classList.add("selected");
    div.textContent = "Vacío";
    return div;
  }

  function isSelectedCard(cardId, zone, index) {
    if (!selected || selected.kind !== "card") return false;
    if (selected.cardId !== cardId) return false;
    if (selected.zone !== zone) return false;
    if (zone === "marketLow" || zone === "marketHigh") return selected.index === index;
    return true;
  }

  function isSelectedEmpty(zone, index) {
    return !!selected && selected.kind === "empty" && selected.zone === zone && selected.index === index;
  }

  function renderMarket() {
    els.marketLow.innerHTML = "";
    marketState.marketLow.forEach((cardId, i) => {
      els.marketLow.appendChild(cardId ? cardThumbEl(cardId, "marketLow", i) : emptySlotEl("marketLow", i));
    });
    els.marketHigh.innerHTML = "";
    marketState.marketHigh.forEach((cardId, i) => {
      els.marketHigh.appendChild(cardId ? cardThumbEl(cardId, "marketHigh", i) : emptySlotEl("marketHigh", i));
    });
  }

  function renderDiscard() {
    els.discardCount.textContent = marketState.discard.length;
    els.discardGrid.innerHTML = "";
    // show most recently discarded first
    discardIds().forEach((cardId) => {
      els.discardGrid.appendChild(cardThumbEl(cardId, "discard"));
    });
  }

  function sortedPoolIds() {
    const query = normalize(els.poolSearch.value.trim());
    let ids = currentPoolIds();
    ids.sort((a, b) => {
      const ca = cardsById[a], cb = cardsById[b];
      if (ca.level !== cb.level) return ca.level - cb.level;
      return ca.name.es.localeCompare(cb.name.es, "es");
    });
    if (query) ids = ids.filter((id) => normalize(cardsById[id].name.es).includes(query));
    return ids;
  }

  function discardIds() {
    return [...marketState.discard].reverse();
  }

  function renderPool() {
    els.poolGrid.innerHTML = "";
    for (const id of sortedPoolIds()) els.poolGrid.appendChild(cardThumbEl(id, "pool"));
  }

  function renderSelectionBanner() {
    if (!selected) {
      els.selectionBanner.hidden = true;
      return;
    }
    els.selectionBanner.hidden = false;
    els.btnCancelSelection.hidden = false;
    if (selected.kind === "card") {
      const c = cardsById[selected.cardId];
      els.selectionText.textContent = `Seleccionado: ${c.name.es} — toca el destino (otra carta o un espacio).`;
    } else {
      els.selectionText.textContent = "Espacio seleccionado — toca una carta para colocarla ahí.";
    }
  }

  function renderAll() {
    renderMarket();
    renderDiscard();
    renderPool();
    renderSelectionBanner();
  }

  els.poolSearch.addEventListener("input", renderPool);

  // ---------- Selection resolution ----------

  function clearSelection() {
    selected = null;
    renderSelectionBanner();
    renderAll();
  }

  els.btnCancelSelection.addEventListener("click", clearSelection);

  function isMarketZone(z) {
    return z === "marketLow" || z === "marketHigh";
  }

  function resolvePair(first, second) {
    if (first.kind === "card" && second.kind === "card" && first.cardId === second.cardId) {
      return { deselect: true };
    }
    if (first.kind === "empty" && second.kind === "empty" && first.zone === second.zone && first.index === second.index) {
      return { deselect: true };
    }

    const unslotted = (z) => z === "pool" || z === "discard";
    if (first.kind === "card" && second.kind === "card" && unslotted(first.zone) && unslotted(second.zone)) {
      return { reselect: second };
    }
    if (first.kind === "empty" && second.kind === "empty") {
      return { reselect: second };
    }

    if (first.kind === "empty" && second.kind === "card") {
      return { move: second.cardId, to: { zone: first.zone, index: first.index } };
    }
    if (second.kind === "empty" && first.kind === "card") {
      return { move: first.cardId, to: { zone: second.zone, index: second.index } };
    }

    // zone-button target (discard pile clicked while something selected)
    if (second.kind === "zonebtn" && second.zone === "discard") {
      if (first.kind === "card") return { move: first.cardId, to: { zone: "discard" } };
      return { invalid: true };
    }

    if (isMarketZone(first.zone) && isMarketZone(second.zone)) {
      return { move: first.cardId, to: { zone: second.zone, index: second.index } };
    }
    if (isMarketZone(first.zone) && second.zone === "discard") {
      return { move: first.cardId, to: { zone: "discard" } };
    }
    if (isMarketZone(second.zone) && first.zone === "discard") {
      return { move: first.cardId, to: { zone: second.zone, index: second.index } };
    }
    if (isMarketZone(first.zone) && second.zone === "pool") {
      return { move: second.cardId, to: { zone: first.zone, index: first.index } };
    }
    if (isMarketZone(second.zone) && first.zone === "pool") {
      return { move: first.cardId, to: { zone: second.zone, index: second.index } };
    }
    if (first.zone === "pool" && second.zone === "discard") {
      return { move: first.cardId, to: { zone: "discard" } };
    }
    if (first.zone === "discard" && second.zone === "pool") {
      return { move: first.cardId, to: { zone: "pool" } };
    }

    return { invalid: true };
  }

  function onTargetChosen(target) {
    if (!selected) {
      selected = target;
      renderSelectionBanner();
      renderAll();
      return;
    }
    const result = resolvePair(selected, target);
    if (result.deselect) {
      clearSelection();
    } else if (result.reselect) {
      selected = result.reselect;
      renderSelectionBanner();
      renderAll();
    } else if (result.move) {
      sendMove(result.move, result.to);
      selected = null;
      renderSelectionBanner();
    } else {
      flashToast("Ese movimiento no es válido.");
    }
  }

  // ---------- Global click delegation ----------

  document.addEventListener("click", (e) => {
    const zoomBtn = e.target.closest(".card-zoom-btn");
    if (zoomBtn) {
      const hostCard = zoomBtn.closest("[data-cardid]");
      const zone = hostCard ? hostCard.dataset.zone : undefined;
      const index = hostCard && hostCard.dataset.index !== undefined ? parseInt(hostCard.dataset.index, 10) : undefined;
      openZoom(zoomBtn.dataset.zoomid, zone, index);
      return;
    }

    const zoomActionBtn = e.target.closest(".zoom-action-btn");
    if (zoomActionBtn) {
      if (!zoomState) return;
      const entry = zoomState.entries[zoomState.index];
      onTargetChosen({ kind: "card", cardId: entry.id, zone: entry.zone, index: entry.index });
      closeZoom();
      return;
    }

    const discardBtn = e.target.closest("#discardPile");
    if (discardBtn) {
      if (selected) {
        onTargetChosen({ kind: "zonebtn", zone: "discard" });
      } else {
        els.discardGrid.hidden = !els.discardGrid.hidden;
      }
      return;
    }

    const cardEl = e.target.closest("[data-cardid]");
    if (cardEl) {
      const target = {
        kind: "card",
        cardId: cardEl.dataset.cardid,
        zone: cardEl.dataset.zone,
        index: cardEl.dataset.index !== undefined ? parseInt(cardEl.dataset.index, 10) : undefined,
      };
      onTargetChosen(target);
      return;
    }

    const emptyEl = e.target.closest("[data-emptyzone]");
    if (emptyEl) {
      const target = { kind: "empty", zone: emptyEl.dataset.emptyzone, index: parseInt(emptyEl.dataset.emptyindex, 10) };
      onTargetChosen(target);
    }
  });

  // ---------- Zoom modal ----------

  let zoomState = null; // { entries: [{id, zone, index}], index: n, carousel: bool }

  function marketCardEntries() {
    const entries = [];
    marketState.marketLow.forEach((id, i) => { if (id) entries.push({ id, zone: "marketLow", index: i }); });
    marketState.marketHigh.forEach((id, i) => { if (id) entries.push({ id, zone: "marketHigh", index: i }); });
    return entries;
  }

  function zoneEntries(zone) {
    if (zone === "marketLow" || zone === "marketHigh") return marketCardEntries();
    if (zone === "discard") return discardIds().map((id) => ({ id, zone: "discard", index: undefined }));
    if (zone === "pool") return sortedPoolIds().map((id) => ({ id, zone: "pool", index: undefined }));
    return [];
  }

  function openZoom(cardId, zone, index) {
    const entries = zoneEntries(zone);
    const idx = entries.findIndex((e) => e.id === cardId);
    zoomState = idx >= 0
      ? { entries, index: idx, carousel: true }
      : { entries: [{ id: cardId, zone, index }], index: 0, carousel: false };
    renderZoomCard();
    els.zoomModal.hidden = false;
  }

  function renderZoomCard() {
    const entry = zoomState.entries[zoomState.index];
    const c = cardsById[entry.id];
    if (!c) return;
    const alreadySelected = isSelectedCard(entry.id, entry.zone, entry.index);
    const label = !selected ? "Seleccionar para mover" : (alreadySelected ? "Cancelar selección" : "Mover aquí");
    const btnClass = alreadySelected ? "btn-secondary" : "btn-primary";
    els.zoomCardHost.innerHTML = `
      <div class="zoom-card">
        <img src="assets/cards/${c.id}.jpg" alt="${c.name.es}" />
      </div>
      <div class="zoom-actions">
        <button type="button" class="btn ${btnClass} zoom-action-btn">${label}</button>
      </div>
    `;
    const hasCarousel = zoomState.carousel && zoomState.entries.length > 1;
    els.zoomPrev.hidden = !hasCarousel;
    els.zoomNext.hidden = !hasCarousel;
  }

  function zoomStep(delta) {
    if (!zoomState || !zoomState.carousel) return;
    const n = zoomState.entries.length;
    zoomState.index = (zoomState.index + delta + n) % n;
    renderZoomCard();
  }

  function closeZoom() {
    els.zoomModal.hidden = true;
    els.zoomCardHost.innerHTML = "";
    zoomState = null;
  }

  els.zoomClose.addEventListener("click", closeZoom);
  els.zoomModal.querySelector(".zoom-backdrop").addEventListener("click", closeZoom);
  els.zoomPrev.addEventListener("click", () => zoomStep(-1));
  els.zoomNext.addEventListener("click", () => zoomStep(1));

  document.addEventListener("keydown", (e) => {
    if (els.zoomModal.hidden) return;
    if (e.key === "ArrowLeft") zoomStep(-1);
    else if (e.key === "ArrowRight") zoomStep(1);
    else if (e.key === "Escape") closeZoom();
  });

  // ---------- Reset / confirm modal ----------

  function openConfirm(text, onOk) {
    els.confirmText.textContent = text;
    els.confirmModal.hidden = false;
    const cleanup = () => {
      els.confirmModal.hidden = true;
      els.confirmOk.removeEventListener("click", okHandler);
      els.confirmCancel.removeEventListener("click", cancelHandler);
    };
    const okHandler = () => { cleanup(); onOk(); };
    const cancelHandler = () => cleanup();
    els.confirmOk.addEventListener("click", okHandler);
    els.confirmCancel.addEventListener("click", cancelHandler);
  }

  els.btnReset.addEventListener("click", () => {
    openConfirm("¿Reiniciar el mercado? Las 6 cartas actuales pasarán al descarte.", () => {
      sendReset();
      clearSelection();
    });
  });

  els.confirmModal.querySelector(".zoom-backdrop").addEventListener("click", () => {
    els.confirmModal.hidden = true;
  });

  // ---------- Room code sharing ----------

  els.btnShowCode.addEventListener("click", async () => {
    const url = new URL(location.href);
    url.searchParams.set("room", roomCode);
    try {
      await navigator.clipboard.writeText(url.toString());
      flashToast("Enlace de la sala copiado.");
    } catch {
      flashToast(`Código de sala: ${roomCode}`);
    }
  });

  // ---------- Boot ----------

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }

  (async function boot() {
    await loadCards();
    const code = getRoomFromUrl();
    if (code) enterRoom(code);
  })();
})();
