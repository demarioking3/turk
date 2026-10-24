/*
 * TURK — browser client.
 * The server decides everything (cards, turns, timer, scores). This file only shows the state it
 * receives and sends the player's choices. Player names are always inserted as plain text.
 */
import TurkMusic from "./turk-music.js";

const $ = (id) => document.getElementById(id);
const NAME_RE = /^[\p{L}\p{M}\p{N} ._\-'!?&#]+$/u;
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;
const SUIT = { S: "♠︎", H: "♥︎", D: "♦︎", C: "♣︎" };
const SUIT_NAME = { S: "spades", H: "hearts", D: "diamonds", C: "clubs" };
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

const S = {
  code: null, pollId: 0, pollAbort: null, joined: false, leaving: false, retries: 0, retryTimer: null,
  view: null, offset: 0, me: null, pendingName: null,
  selected: new Set(), hitMode: false, prevHand: [], prevDiscard: null,
  busy: false, busyTimer: null, shownResultFor: null,
  handKey: "", handRound: null, seenSpreads: new Set(), seenLobby: new Set(),
};

/* ---------------- small helpers ---------------- */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function show(screen) {
  for (const id of ["home", "lobby", "table", "error"]) $(id).hidden = id !== screen;
  const music = TurkMusic.get();
  if (music && music.root) {
    const slot = screen === "table" ? $("music-slot-table") : screen === "lobby" ? $("music-slot-lobby") : null;
    if (slot && music.root.parentNode !== slot) slot.appendChild(music.root);
  }
}
function cleanName(raw) {
  const name = String(raw || "").normalize("NFC").replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, error: "Enter your name." };
  if ([...name].length > 20) return { ok: false, error: "Names can be up to 20 characters." };
  if (!NAME_RE.test(name)) return { ok: false, error: "Use letters, numbers, spaces and . _ - ' ! ? & # only." };
  return { ok: true, name };
}
function store(key, val) { try { val == null ? localStorage.removeItem(key) : localStorage.setItem(key, val); } catch {} }
function read(key) { try { return localStorage.getItem(key); } catch { return null; } }
let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}
function banner(msg) { const b = $("banner"); b.textContent = msg || ""; b.hidden = !msg; }
function serverNow() { return Date.now() + S.offset; }

/* ---------------- cards ---------------- */
const rankOf = (c) => c.slice(0, -1);
const suitOf = (c) => c.slice(-1);
const rankValue = (c) => RANKS.indexOf(rankOf(c)) + 1;
function cardLabel(c) { return rankOf(c) + SUIT[suitOf(c)]; }
function cardSpoken(c) {
  const r = { A: "Ace", J: "Jack", Q: "Queen", K: "King" }[rankOf(c)] || rankOf(c);
  return `${r} of ${SUIT_NAME[suitOf(c)]}`;
}
function crownSvg() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 40 30");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", "M3 26h34l3-20-10 9-10-13-10 13L0 6z");
  p.setAttribute("fill", "#d4a73c");
  p.setAttribute("stroke", "#5a400e");
  p.setAttribute("stroke-width", "1.5");
  svg.appendChild(p);
  return svg;
}
function makeCard(c, extra = "") {
  const s = suitOf(c), r = rankOf(c);
  const card = el("span", "card" + (s === "H" || s === "D" ? " card--red" : "") + (extra ? " " + extra : ""));
  card.setAttribute("role", "img");
  card.setAttribute("aria-label", cardSpoken(c));
  card.dataset.card = c;
  for (const pos of ["tl", "br"]) {
    const corner = el("span", "card__corner card__corner--" + pos);
    corner.append(el("span", "card__rank", r), el("span", "card__suit", SUIT[s]));
    corner.setAttribute("aria-hidden", "true");
    card.appendChild(corner);
  }
  if (r === "J" || r === "Q" || r === "K") {
    const face = el("span", "card__face");
    face.setAttribute("aria-hidden", "true");
    face.appendChild(crownSvg());
    face.appendChild(el("span", "card__face-letter", r + SUIT[s]));
    card.appendChild(face);
  } else {
    const pip = el("span", "card__pip", SUIT[s]);
    pip.setAttribute("aria-hidden", "true");
    card.appendChild(pip);
  }
  return card;
}
function cardBack(cls = "") { const b = el("span", "card card--back " + cls); b.setAttribute("aria-hidden", "true"); return b; }

function spreadKind(cards) {
  if (cards.length < 3 || new Set(cards).size !== cards.length) return null;
  if (cards.length <= 4 && cards.every((c) => rankOf(c) === rankOf(cards[0]))) return "set";
  if (!cards.every((c) => suitOf(c) === suitOf(cards[0]))) return null;
  const v = cards.map(rankValue).sort((a, b) => a - b);
  for (let i = 1; i < v.length; i++) if (v[i] !== v[i - 1] + 1) return null;
  return "run";
}
function canHit(spread, c) {
  if (spread.kind === "set") return spread.cards.length < 4 && rankOf(c) === rankOf(spread.cards[0]);
  if (suitOf(c) !== suitOf(spread.cards[0])) return false;
  const lo = rankValue(spread.cards[0]), hi = rankValue(spread.cards[spread.cards.length - 1]), v = rankValue(c);
  return v === lo - 1 || v === hi + 1;
}
function sortHand(hand) {
  const order = { S: 0, H: 1, C: 2, D: 3 };
  return hand.slice().sort((a, b) => order[suitOf(a)] - order[suitOf(b)] || rankValue(a) - rankValue(b));
}

/* ---------------- names / avatars ---------------- */
function players() { return (S.view && S.view.room.players) || []; }
function seatIndex(id) {
  const g = S.view && S.view.game;
  const list = g ? g.seats : players().map((p) => p.id);
  return Math.max(0, list.indexOf(id));
}
function nameOf(id) {
  const p = players().find((x) => x.id === id);
  if (!p) return "Someone";
  const same = players().filter((x) => x.name.toLowerCase() === p.name.toLowerCase());
  return same.length > 1 ? `${p.name} (#${seatIndex(id) + 1})` : p.name; // duplicate names get a seat number
}
function initials(name) {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : [...parts[0]].slice(0, 2).join("")).toUpperCase();
}
function avatar(id) {
  const p = players().find((x) => x.id === id);
  const a = el("span", "avatar", initials(p ? p.name : "?"));
  a.dataset.c = String(seatIndex(id) % 4);
  a.setAttribute("aria-hidden", "true");
  return a;
}

/* ---------------- networking (HTTP + long polling; works on Cloudflare Pages) ---------------- */
const BASE = "";
const API = BASE + "/api";
function token() { return read("turk:t:" + S.code) || ""; }
async function api(path, { method = "GET", body, signal } = {}) {
  const res = await fetch(API + path, {
    method, signal, cache: "no-store",
    headers: Object.assign({ "X-Turk-Token": token() }, body ? { "content-type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return { status: 204, data: null };
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data: data || {} };
}

async function connect(code, name) {
  S.code = code;
  S.leaving = false;
  S.pendingName = name || null;
  clearTimeout(S.retryTimer);
  let r;
  try { r = await api(`/rooms/${code}/join`, { method: "POST", body: { name: S.pendingName || undefined, token: token() || undefined } }); }
  catch { return failConnect(); }
  if (r.status === 404) {
    store("turk:t:" + code, null);
    history.replaceState(null, "", BASE + "/");
    return goHome("That game has ended or the room was closed.", null);
  }
  if (r.status !== 200) {
    if (r.status >= 500) return failConnect();
    if (r.data.code === "rejoin") store("turk:t:" + code, null);
    return goHome(r.data.error || "Couldn't join that room.", code);
  }
  S.joined = true;
  S.me = r.data.id;
  S.retries = 0;
  store("turk:t:" + code, r.data.token);
  if (S.pendingName) store("turk:name", S.pendingName);
  S.pendingName = null;
  history.replaceState(null, "", `${BASE}/?room=${code}`);
  if (!TurkMusic.get()) TurkMusic.init({ mount: $("music-slot-lobby"), lobbySrc: BASE + "/audio/turk-lobby.mp3", tableSrc: BASE + "/audio/turk-table.mp3" });
  banner("");
  onState(r.data.state);
  poll(++S.pollId);
}

/* Ask the server for anything newer than what we have; it answers as soon as something changes (or after ~20s). */
async function poll(id) {
  while (S.joined && !S.leaving && id === S.pollId) {
    const since = S.view ? S.view.version : 0;
    S.pollAbort = new AbortController();
    let r;
    try { r = await api(`/rooms/${S.code}/state?since=${since}`, { signal: S.pollAbort.signal }); }
    catch (e) {
      if (id !== S.pollId || S.leaving) return;
      S.retries += 1;
      if (S.retries > 10) return failConnect();
      banner("Connection lost — reconnecting…");
      await new Promise((ok) => { S.retryTimer = setTimeout(ok, Math.min(8000, 500 * 2 ** S.retries)); });
      continue;
    }
    if (id !== S.pollId || S.leaving) return;
    if (r.status === 200 && r.data.state) { S.retries = 0; banner(""); onState(r.data.state); continue; }
    if (r.status === 204) { S.retries = 0; banner(""); continue; }
    if (r.status === 403 || r.status === 404) {
      store("turk:t:" + S.code, null);
      S.joined = false;
      history.replaceState(null, "", BASE + "/");
      return goHome(r.data.error || "You're no longer in that room.", null);
    }
    S.retries += 1;
    if (S.retries > 10) return failConnect();
    banner("Connection trouble — retrying…");
    await new Promise((ok) => { S.retryTimer = setTimeout(ok, Math.min(8000, 500 * 2 ** S.retries)); });
  }
}
function restartPoll() { try { S.pollAbort && S.pollAbort.abort(); } catch {} poll(++S.pollId); }

function failConnect() {
  S.joined = false;
  S.pollId++;
  banner("");
  $("error-title").textContent = "The game server isn't answering";
  $("error-text").textContent = "Check your connection and try again. If it keeps happening, the game may be down for a moment.";
  show("error");
}
async function send(msg, { guard = true } = {}) {
  if (!S.joined) { toast("Not connected yet — hang on."); return false; }
  if (guard) {
    if (S.busy) return false;
    S.busy = true;
    clearTimeout(S.busyTimer);
    S.busyTimer = setTimeout(() => { S.busy = false; }, 4000);
  }
  try {
    const r = await api(`/rooms/${S.code}/act`, { method: "POST", body: msg });
    S.busy = false;
    if (r.status === 200 && r.data.state) { onState(r.data.state); restartPoll(); return true; }
    if (r.status === 403 || r.status === 404) {
      store("turk:t:" + S.code, null);
      S.joined = false; S.pollId++;
      goHome(r.data.error || "You're no longer in that room.", null);
      return false;
    }
    toast(r.data.error || "Something went wrong — try again.");
  } catch {
    S.busy = false;
    toast("Couldn't reach the game server — try again.");
  }
  return false;
}

/* ---------------- state ---------------- */
function onState(v) {
  if (!v || (S.view && v.version < S.view.version)) return; // ignore anything older than what we're showing
  S.busy = false;
  S.offset = v.now - Date.now();
  const prev = S.view;
  S.view = v;
  const g = v.game;
  if (v.room.phase === "lobby") {
    S.selected.clear(); S.hitMode = false; S.shownResultFor = null;
    S.handKey = ""; S.handRound = null; S.prevHand = []; S.seenSpreads.clear();
    closeDialogs();
    show("lobby");
    renderLobby();
    TurkMusic.setScene("lobby");
  } else {
    show("table");
    renderTable(prev);
    TurkMusic.setScene(g && g.status === "playing" ? "table" : "lobby");
  }
}

/* ---------------- lobby ---------------- */
function renderLobby() {
  const v = S.view, room = v.room;
  $("lobby-code").textContent = room.code;
  $("lobby-vis").textContent = room.public ? "Public" : "Private";
  const ps = room.players.filter((p) => !p.left);
  $("lobby-count").textContent = `(${ps.length}/${room.max})`;
  const list = $("lobby-players");
  list.textContent = "";
  for (const p of ps) {
    const li = el("li", "lobby-player" + (p.id === S.me ? " is-me" : "") + (S.seenLobby.has(p.id) ? "" : " is-new"));
    S.seenLobby.add(p.id);
    li.appendChild(avatar(p.id));
    li.appendChild(el("span", "lobby-player__name", nameOf(p.id)));
    const tags = el("span", "lobby-player__tags");
    if (p.id === S.me) tags.appendChild(el("span", "badge", "You"));
    if (p.host) tags.appendChild(el("span", "badge", "Host"));
    if (!p.connected) tags.appendChild(el("span", "badge tag-off", "Offline"));
    else tags.appendChild(el("span", "badge " + (p.ready ? "tag-ready" : "tag-wait"), p.ready ? "Ready" : "Not ready"));
    li.appendChild(tags);
    list.appendChild(li);
  }
  for (let i = ps.length; i < room.max; i++) list.appendChild(el("li", "lobby-empty", "Open seat — share the code or link"));
  const me = ps.find((p) => p.id === S.me);
  const rb = $("ready-btn");
  rb.textContent = me && me.ready ? "Not Ready" : "I'm Ready";
  rb.className = "btn btn--wide " + (me && me.ready ? "btn--ghost" : "btn--gold");
  updateLobbyStatus();
}
function updateLobbyStatus() {
  const v = S.view;
  if (!v || v.room.phase !== "lobby") return;
  const st = $("lobby-status");
  const ps = v.room.players.filter((p) => !p.left);
  if (v.room.countdownAt) {
    const s = Math.max(0, Math.ceil((v.room.countdownAt - serverNow()) / 1000));
    st.textContent = s > 0 ? `Game starting in ${s}…` : "Dealing…";
    st.classList.add("is-countdown");
    return;
  }
  st.classList.remove("is-countdown");
  const ready = ps.filter((p) => p.ready).length;
  st.textContent = ps.length < 2 ? "Waiting for at least one more player (2–4 players)…"
    : `Waiting for everyone to ready up — ${ready}/${ps.length} ready. The game starts when all players are ready.`;
}

/* ---------------- table ---------------- */
function renderTable(prev) {
  const v = S.view, g = v.game;
  if (!g) return;
  const myTurn = g.turn === S.me && g.status === "playing";
  const step = g.step;
  const hand = sortHand(v.hand || []);
  // drop selections that are no longer in hand / turn ended
  for (const c of [...S.selected]) if (!hand.includes(c)) S.selected.delete(c);
  if (!myTurn) { S.selected.clear(); S.hitMode = false; }

  $("round-label").textContent = `Round ${g.roundNumber} · First to ${g.roundsToWin} wins`;

  // opponents, in turn order starting after me
  const seats = g.seats;
  const myIdx = Math.max(0, seats.indexOf(S.me));
  const others = seats.slice(myIdx + 1).concat(seats.slice(0, myIdx)).filter((id) => id !== S.me);
  const opp = $("opponents");
  opp.textContent = "";
  for (const id of others) {
    const p = players().find((x) => x.id === id) || { connected: false, left: true };
    const inRound = g.order && g.order.includes(id);
    const seat = el("div", "seat" + (g.turn === id ? " is-turn" : "") + (!p.connected || p.left ? " is-off" : ""));
    seat.appendChild(avatar(id));
    seat.appendChild(el("span", "seat__name", nameOf(id)));
    const meta = el("span", "seat__meta");
    const n = inRound && g.cardCounts ? g.cardCounts[id] || 0 : 0;
    const backs = el("span", "seat__cards");
    for (let i = 0; i < Math.min(n, 7); i++) backs.appendChild(cardBack("card--sm"));
    meta.appendChild(backs);
    meta.appendChild(el("span", null, `${n} card${n === 1 ? "" : "s"}`));
    meta.appendChild(el("span", null, `🏆${g.roundsWon[id] || 0} · ${g.score[id] || 0} pts`));
    if (p.left) meta.appendChild(el("span", "seat__status", "Left"));
    else if (!p.connected) meta.appendChild(el("span", "seat__status", "Offline"));
    seat.appendChild(meta);
    if (g.turn === id) seat.appendChild(el("span", "seat__turn", "Turn"));
    seat.setAttribute("aria-label", `${nameOf(id)}: ${n} cards, ${g.roundsWon[id] || 0} rounds won, ${g.score[id] || 0} points${g.turn === id ? ", playing now" : ""}`);
    opp.appendChild(seat);
  }

  // turn indicator
  const turnBox = $("turn");
  if (g.status === "playing") {
    turnBox.hidden = false;
    turnBox.classList.toggle("is-me", myTurn);
    $("turn-who").textContent = myTurn ? "Your turn" : `${nameOf(g.turn)}'s turn`;
    if (!prev || !prev.game || prev.game.turnSeq !== g.turnSeq) { turnBox.style.animation = "none"; void turnBox.offsetWidth; turnBox.style.animation = ""; }
  } else {
    turnBox.hidden = true;
  }

  // piles
  const canDraw = myTurn && step === "draw";
  const stock = $("stock"), disc = $("discard");
  stock.disabled = !canDraw || !g.stockCount;
  disc.disabled = !canDraw || !g.discardTop;
  stock.classList.toggle("is-live", canDraw);
  disc.classList.toggle("is-live", canDraw && !!g.discardTop);
  $("stock-count").textContent = g.stockCount ?? "";
  $("discard-count").textContent = g.discardCount ?? "";
  const slot = $("discard-top");
  slot.textContent = "";
  if (g.discardTop) slot.appendChild(makeCard(g.discardTop, S.prevDiscard !== g.discardTop ? "is-new" : ""));
  disc.setAttribute("aria-label", g.discardTop ? `Take the ${cardSpoken(g.discardTop)} from the discard pile` : "Discard pile is empty");
  S.prevDiscard = g.discardTop;

  // spreads
  const sp = $("spreads");
  sp.textContent = "";
  const one = S.selected.size === 1 ? [...S.selected][0] : null;
  for (const s of g.spreads || []) {
    const target = myTurn && step === "play" && S.hitMode && one && canHit(s, one);
    const sk = g.roundNumber + ":" + s.id;
    const box = el(target ? "button" : "div", "spread" + (target ? " is-target" : "") + (S.seenSpreads.has(sk) ? "" : " is-new"));
    S.seenSpreads.add(sk);
    if (target) {
      box.type = "button";
      box.setAttribute("aria-label", `Add ${cardSpoken(one)} to ${nameOf(s.owner)}'s ${s.kind}`);
      box.addEventListener("click", () => { if (send({ t: "hit", card: one, spread: s.id })) { S.selected.clear(); S.hitMode = false; } });
    }
    box.appendChild(el("span", "spread__owner", (s.owner === S.me ? "Your" : nameOf(s.owner) + "'s") + (s.kind === "run" ? " run" : " set")));
    const cards = el("span", "spread__cards");
    s.cards.forEach((c) => cards.appendChild(makeCard(c)));
    box.appendChild(cards);
    sp.appendChild(box);
  }

  // recent moves
  const feed = $("feed");
  feed.textContent = "";
  (g.log || []).slice(-4).reverse().forEach((e) => { const t = describe(e); if (t) feed.appendChild(el("li", null, t)); });

  // my hand
  const me = $("me");
  me.classList.toggle("is-turn", myTurn);
  $("me-avatar").replaceWith(Object.assign(avatar(S.me), { id: "me-avatar" }));
  $("me-name").textContent = nameOf(S.me) + " (you)";
  $("me-stats").textContent = `🏆 ${g.roundsWon[S.me] || 0} · ${g.score[S.me] || 0} pts`;
  // Only rebuild the hand when it actually changed, so cards sit still while you wait and taps never get lost.
  const handBox = $("hand");
  const canSelect = myTurn && g.status === "playing";
  handBox.classList.toggle("is-disabled", !canSelect);
  const handKey = [g.roundNumber, hand.join(","), [...S.selected].sort().join(","), canSelect].join("|");
  if (handKey !== S.handKey) {
    const newRound = S.handRound !== g.roundNumber;
    const prevSet = new Set(S.prevHand);
    handBox.textContent = "";
    for (const c of hand) {
      const anim = newRound ? " is-dealt" : !prevSet.has(c) ? " is-new" : "";
      const card = makeCard(c, (S.selected.has(c) ? "is-selected" : "") + anim);
      card.setAttribute("role", "button");
      card.tabIndex = 0;
      card.setAttribute("aria-pressed", String(S.selected.has(c)));
      const toggle = () => {
        if (!canSelect) return;
        S.selected.has(c) ? S.selected.delete(c) : S.selected.add(c);
        if (S.selected.size !== 1) S.hitMode = false;
        renderTable(S.view);
      };
      card.addEventListener("click", toggle);
      card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
      handBox.appendChild(card);
    }
    S.handKey = handKey;
    S.handRound = g.roundNumber;
    S.prevHand = hand;
  }

  // actions
  const sel = [...S.selected];
  const playing = g.status === "playing";
  $("drop-btn").disabled = !(myTurn && playing);
  $("spread-btn").disabled = !(myTurn && step === "play" && spreadKind(sel));
  $("hit-btn").disabled = !(myTurn && step === "play" && sel.length === 1 && (g.spreads || []).some((s) => canHit(s, sel[0])));
  $("hit-btn").textContent = S.hitMode ? "Cancel" : "Add to Spread";
  $("discard-btn").disabled = !(myTurn && step === "play" && sel.length === 1 && !(g.tookDiscard === sel[0] && hand.length > 1));

  // hint
  let hint = "";
  if (!playing) hint = "";
  else if (!myTurn) hint = `Waiting for ${nameOf(g.turn)}…`;
  else if (step === "draw" && spreadKind(sel)) hint = "Nice spread! Draw a card first (deck or discard), then tap Lay Down.";
  else if (step === "draw") hint = "Draw first: tap the deck or the top discard. Or DROP if you think you're lowest.";
  else if (S.hitMode) hint = "Tap a glowing spread to add your card.";
  else if (spreadKind(sel)) hint = `That's a ${spreadKind(sel)}! Tap Lay Down to put it on the table, then discard one card to end your turn.`;
  else if (sel.length >= 3) hint = "Those cards don't make a spread yet (3–4 of a kind, or 3+ in a row of one suit).";
  else hint = "Tap cards to lay down a set or run, or add to a spread. Then pick one card and Discard to end your turn.";
  $("hint").textContent = hint;

  updateTimer();
  maybeShowResult();
}

function describe(e) {
  const n = (id) => (id === S.me ? "You" : nameOf(id));
  switch (e.t) {
    case "deal": return `New round — ${n(e.first)} ${e.first === S.me ? "go" : "goes"} first`;
    case "draw": return e.from === "discard" ? `${n(e.by)} took from the discard pile` : `${n(e.by)} drew from the deck`;
    case "spread": return `${n(e.by)} laid down ${e.cards.map(cardLabel).join(" ")}`;
    case "hit": return `${n(e.by)} added ${cardLabel(e.card)} to ${e.owner === e.by ? "their own" : n(e.owner) + "'s"} spread`;
    case "discard": return `${n(e.by)} discarded`;
    case "timeout": return `${n(e.by)} ran out of time`;
    case "reshuffle": return "The discard pile was shuffled into a new deck";
    case "left": return `${n(e.by)} left the game`;
    case "end": return "Round over";
    default: return "";
  }
}

/* ---------------- timers ---------------- */
function updateTimer() {
  const g = S.view && S.view.game;
  const t = $("turn-timer");
  if (!g || g.status !== "playing" || !g.turnDeadline) { t.textContent = ""; return; }
  const ms = Math.max(0, g.turnDeadline - serverNow());
  const s = Math.ceil(ms / 1000);
  t.textContent = String(s);
  t.style.setProperty("--p", String(Math.min(1, ms / (g.turnMs || 30000))));
  t.classList.toggle("is-low", s <= 10);
  t.setAttribute("aria-label", `${s} seconds left`);
}
function updateNextButton() {
  const g = S.view && S.view.game;
  if (!g || g.status !== "roundOver") return;
  const btn = $("round-next");
  const waiting = (g.continued || []).includes(S.me);
  const s = g.nextRoundAt ? Math.max(0, Math.ceil((g.nextRoundAt - serverNow()) / 1000)) : 0;
  btn.textContent = waiting ? `Waiting for others… ${s}s` : `Next round (${s}s)`;
  btn.disabled = waiting;
}
setInterval(() => { updateTimer(); updateLobbyStatus(); updateNextButton(); }, 250);

/* ---------------- round summary / winner ---------------- */
function maybeShowResult() {
  const g = S.view.game;
  const dlg = $("round-dialog");
  if (!g || g.status === "playing" || !g.order) { if (dlg.open) dlg.close(); return; }
  const key = g.roundNumber + ":" + g.status;
  if (S.shownResultFor === key && dlg.open) { updateNextButton(); renderResultRows(); return; }
  S.shownResultFor = key;
  const r = g.result;
  const title = $("round-title"), sub = $("round-sub");
  if (g.status === "over") {
    title.textContent = "Game Over";
  } else {
    title.textContent = `Round ${g.roundNumber}`;
  }
  sub.textContent = r ? resultLine(r) : "";
  renderResultRows();
  const next = $("round-next");
  next.onclick = null;
  if (g.status === "over") {
    next.textContent = "Play again";
    next.disabled = false;
    next.onclick = () => send({ t: "rematch" });
    $("round-leave").hidden = false;
  } else {
    $("round-leave").hidden = true;
    next.onclick = () => send({ t: "continue" }, { guard: false });
    updateNextButton();
  }
  if (!dlg.open) dlg.showModal();
}
function resultLine(r) {
  const n = (id) => (id === S.me ? "You" : nameOf(id));
  const win = r.winners.length === 1 ? n(r.winners[0]) : null;
  switch (r.how) {
    case "out": return `${n(r.by)} went out — no cards left!`;
    case "tunk": return `TUNK! ${n(r.by)} was dealt exactly 21 and dropped. Instant win.`;
    case "drop":
      if (!r.caught) return `${n(r.by)} dropped with the lowest hand and won the round.`;
      return win ? `${n(r.by)} dropped but got CAUGHT. ${win} had the lowest hand.` : `${n(r.by)} dropped but got CAUGHT. Tied lowest — nobody wins this round.`;
    case "stock": return win ? `The deck ran out. ${win} had the lowest hand.` : "The deck ran out with a tie — nobody wins this round.";
    case "forfeit": return "Everyone else left the table.";
    default: return "";
  }
}
function renderResultRows() {
  const g = S.view.game, r = g.result;
  const box = $("round-table");
  box.textContent = "";
  if (g.status === "over" && g.winner) {
    const burst = el("div", "winner-burst");
    const logo = el("div", "logo", "👑");
    burst.appendChild(logo);
    burst.appendChild(el("div", "winner-burst__name", g.winner === S.me ? "You win TURK!" : `${nameOf(g.winner)} wins TURK!`));
    box.appendChild(burst);
  }
  const ids = (r && r.hands && Object.keys(r.hands).length ? Object.keys(r.hands) : g.seats).slice()
    .sort((a, b) => (r && r.points ? (r.points[a] ?? 99) - (r.points[b] ?? 99) : 0));
  for (const id of ids) {
    const isWin = r && r.winners.includes(id);
    const row = el("div", "round__row" + (isWin ? " is-winner" : ""));
    const name = el("div", "round__name");
    name.appendChild(avatar(id));
    name.appendChild(el("span", null, (id === S.me ? "You" : nameOf(id))));
    if (isWin && !r.tie) name.appendChild(el("span", "crown", "👑"));
    if (r && r.caught && r.by === id) name.appendChild(el("span", "badge tag-off", "Caught"));
    row.appendChild(name);
    const pts = el("div", "round__pts");
    if (r && r.points && id in r.points) {
      pts.appendChild(el("b", null, `${r.points[id]} pts`));
      pts.appendChild(document.createTextNode(` in hand · +${r.added[id]} → `));
    }
    pts.appendChild(el("b", null, `${g.score[id]} total`));
    pts.appendChild(document.createTextNode(` · 🏆${g.roundsWon[id]}`));
    row.appendChild(pts);
    if (r && r.hands && r.hands[id]) {
      const cards = el("div", "round__cards");
      sortHand(r.hands[id]).forEach((c) => cards.appendChild(makeCard(c)));
      if (!r.hands[id].length) cards.appendChild(el("span", "badge", "Empty hand"));
      row.appendChild(cards);
    }
    box.appendChild(row);
  }
}
function renderScoreboard() {
  const g = S.view && S.view.game;
  const box = $("score-table");
  box.textContent = "";
  if (!g) return;
  const t = el("table", "score-table");
  const head = el("tr");
  ["Player", "Rounds won", "Score", "Cards"].forEach((h) => head.appendChild(el("th", null, h)));
  t.appendChild(head);
  const ids = g.seats.slice().sort((a, b) => (g.roundsWon[b] - g.roundsWon[a]) || (g.score[a] - g.score[b]));
  for (const id of ids) {
    const tr = el("tr");
    tr.appendChild(el("td", null, (id === S.me ? "You — " : "") + nameOf(id)));
    tr.appendChild(el("td", null, `${g.roundsWon[id]} / ${g.roundsToWin}`));
    tr.appendChild(el("td", null, String(g.score[id])));
    tr.appendChild(el("td", null, g.cardCounts && id in g.cardCounts ? String(g.cardCounts[id]) : "—"));
    t.appendChild(tr);
  }
  box.appendChild(t);
  box.appendChild(el("p", "field__hint", `Lower score is better. First to ${g.roundsToWin} round wins takes the game.`));
}
function closeDialogs() { for (const d of document.querySelectorAll("dialog[open]")) d.close(); }

/* ---------------- home ---------------- */
function goHome(error, code) {
  closeDialogs();
  S.view = null; S.joined = false; S.me = null; S.pollId++;
  banner("");
  show("home");
  const remembered = read("turk:name") || "";
  document.querySelectorAll('#home input[name="name"]').forEach((i) => { if (!i.value) i.value = remembered; });
  if (code) { selectTab("join"); $("form-join").code.value = code; }
  if (error) {
    const f = code ? $("form-join") : $("form-create");
    f.querySelector(".form__error").textContent = error;
  }
  loadPublicRooms();
}
function selectTab(which) {
  const create = which === "create";
  $("tab-create").setAttribute("aria-selected", String(create));
  $("tab-join").setAttribute("aria-selected", String(!create));
  $("form-create").hidden = !create;
  $("form-join").hidden = create;
}
async function loadPublicRooms() {
  const list = $("public-list");
  list.textContent = "";
  try {
    const res = await fetch(API + "/rooms", { cache: "no-store" });
    if (!res.ok) throw new Error();
    const { rooms } = await res.json();
    if (!rooms.length) { list.appendChild(el("li", "public-rooms__empty", "No public games waiting right now. Create one!")); return; }
    for (const r of rooms) {
      const li = el("li", "public-room");
      const info = el("div", "public-room__info");
      info.appendChild(el("div", "public-room__host", `${r.host || "A player"}'s table`));
      info.appendChild(el("div", "public-room__meta", `${r.players}/4 players · ${r.code}`));
      li.appendChild(info);
      const b = el("button", "btn btn--ghost", "Join");
      b.type = "button";
      b.addEventListener("click", () => { selectTab("join"); $("form-join").code.value = r.code; $("form-join").name.focus(); });
      li.appendChild(b);
      list.appendChild(li);
    }
  } catch {
    list.appendChild(el("li", "public-rooms__empty", "Couldn't load public games."));
  }
}

$("tab-create").addEventListener("click", () => selectTab("create"));
$("tab-join").addEventListener("click", () => selectTab("join"));
$("refresh-rooms").addEventListener("click", loadPublicRooms);

$("form-create").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.currentTarget, err = f.querySelector(".form__error"), btn = f.querySelector("button[type=submit]");
  const n = cleanName(f.name.value);
  if (!n.ok) { err.textContent = n.error; f.name.focus(); return; }
  f.name.value = n.name;
  err.textContent = "";
  btn.disabled = true;
  try {
    const res = await fetch(API + "/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ public: f.visibility.value === "public" }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.code) throw new Error(data.error || "Couldn't create a room.");
    connect(data.code, n.name);
  } catch (ex) {
    err.textContent = ex.message || "The game server isn't answering. Try again.";
  } finally { btn.disabled = false; }
});

$("form-join").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.currentTarget, err = f.querySelector(".form__error"), btn = f.querySelector("button[type=submit]");
  const code = f.code.value.trim().toUpperCase();
  if (!CODE_RE.test(code)) { err.textContent = "Room codes are 5 letters/numbers."; f.code.focus(); return; }
  const n = cleanName(f.name.value);
  if (!n.ok) { err.textContent = n.error; f.name.focus(); return; }
  f.name.value = n.name;
  err.textContent = "";
  btn.disabled = true;
  try {
    const res = await fetch(API + "/rooms/" + code, { cache: "no-store" });
    if (res.status === 404) throw new Error("No room with that code.");
    const info = await res.json();
    if (!res.ok || !info.exists) throw new Error("No room with that code.");
    if (info.phase !== "lobby" && !read("turk:t:" + code)) throw new Error("That game has already started.");
    if (info.players >= info.max && !read("turk:t:" + code)) throw new Error("That room is full (4 players max).");
    connect(code, n.name);
  } catch (ex) {
    err.textContent = ex.message || "The game server isn't answering. Try again.";
  } finally { btn.disabled = false; }
});

/* ---------------- lobby / table controls ---------------- */
$("ready-btn").addEventListener("click", () => {
  const me = players().find((p) => p.id === S.me);
  send({ t: "ready", ready: !(me && me.ready) });
});
$("copy-link").addEventListener("click", async () => {
  const link = `${location.origin}${BASE}/?room=${S.code}`;
  try {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) await navigator.share({ title: "Play TURK with me", text: `Join my TURK game — room ${S.code}`, url: link });
    else { await navigator.clipboard.writeText(link); $("copied").textContent = "Link copied!"; setTimeout(() => { $("copied").textContent = ""; }, 2500); }
  } catch { $("copied").textContent = link; }
});
function leaveRoom() {
  S.leaving = true;
  const code = S.code, tok = token();
  S.joined = false; S.pollId++;
  try { S.pollAbort && S.pollAbort.abort(); } catch {}
  fetch(`${API}/rooms/${code}/act`, { method: "POST", keepalive: true, headers: { "content-type": "application/json", "X-Turk-Token": tok }, body: '{"t":"leave"}' }).catch(() => {});
  store("turk:t:" + S.code, null);
  TurkMusic.destroy();
  history.replaceState(null, "", BASE + "/");
  goHome();
}
$("leave-lobby").addEventListener("click", leaveRoom);
$("leave-game").addEventListener("click", () => $("leave-dialog").showModal());
$("leave-dialog").addEventListener("close", () => { if ($("leave-dialog").returnValue === "leave") leaveRoom(); });
$("round-leave").addEventListener("click", leaveRoom);

$("stock").addEventListener("click", () => send({ t: "draw", from: "stock" }));
$("discard").addEventListener("click", () => send({ t: "draw", from: "discard" }));
$("spread-btn").addEventListener("click", () => {
  const cards = [...S.selected];
  if (send({ t: "spread", cards })) { S.selected.clear(); S.hitMode = false; }
});
$("hit-btn").addEventListener("click", () => { S.hitMode = !S.hitMode; renderTable(S.view); });
$("discard-btn").addEventListener("click", () => {
  const [card] = [...S.selected];
  if (card && send({ t: "discard", card })) { S.selected.clear(); S.hitMode = false; }
});
$("drop-btn").addEventListener("click", () => { $("drop-dialog").returnValue = ""; $("drop-dialog").showModal(); });
$("drop-dialog").addEventListener("close", () => { if ($("drop-dialog").returnValue === "drop") send({ t: "drop" }); });
$("score-btn").addEventListener("click", () => { renderScoreboard(); $("score-dialog").showModal(); });
$("score-close").addEventListener("click", () => $("score-dialog").close());
$("round-dialog").addEventListener("cancel", (e) => e.preventDefault()); // keep the summary up until the next round
$("error-retry").addEventListener("click", () => { if (S.code && read("turk:t:" + S.code)) { S.retries = 0; connect(S.code); } else goHome(); });

/* ---------------- start ---------------- */
(function boot() {
  const params = new URLSearchParams(location.search);
  const code = (params.get("room") || "").trim().toUpperCase();
  if (CODE_RE.test(code)) {
    if (read("turk:t:" + code)) { connect(code); return; } // reconnect with the same seat and name
    goHome(null, code);
    $("form-join").name.focus();
    return;
  }
  goHome();
})();
