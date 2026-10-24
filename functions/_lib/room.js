/*
 * TURK room logic, independent of storage and transport.
 * A room is a plain JSON object (`s`). Every request loads it, calls one of these functions, and saves it back
 * (see store.js). The server is the only source of truth: membership, the deck, private hands, turns,
 * the 30-second timer and scoring all live here. Each player only ever receives their own hand.
 */
import * as Rules from "./rules.js";
import { cleanName } from "./names.js";

export const MAX_PLAYERS = 4;
export const TURN_MS = 30_000;
export const COUNTDOWN_MS = 3_000;
export const NEXT_ROUND_MS = 15_000;
export const ONLINE_MS = 15_000;     // a player who hasn't checked in for this long shows as offline
export const PAUSE_GAP_MS = 25_000;  // nobody checked in for this long → timers were paused, restart them fresh
const RATE_WINDOW_MS = 5_000;
const RATE_MAX = 25;

export class TurkError extends Error {
  constructor(message, code) { super(message); this.code = code || null; }
}

function hex(bytes) { return [...bytes].map((x) => x.toString(16).padStart(2, "0")).join(""); }
export function newToken() { const b = new Uint8Array(24); crypto.getRandomValues(b); return hex(b); }
function newId() { const b = new Uint8Array(6); crypto.getRandomValues(b); return "p_" + hex(b); }

export function newRoom(code, isPublic, now = Date.now()) {
  return {
    code, public: !!isPublic, created: now,
    phase: "lobby", players: [], hostId: null, game: null,
    countdownAt: null, turnDeadline: null, nextRoundAt: null, continued: [],
    lastTick: now,
  };
}

/* ---------- helpers ---------- */
const active = (s) => s.players.filter((p) => !p.left);
const online = (p, now) => !p.left && now - (p.seen || 0) < ONLINE_MS;
export function playerByToken(s, token) {
  return typeof token === "string" && token.length === 48 ? s.players.find((p) => p.token === token && !p.left) || null : null;
}
function pickHost(s, now) {
  const next = active(s).find((p) => online(p, now)) || active(s)[0];
  s.hostId = next ? next.id : null;
}
function cancelCountdown(s) { s.countdownAt = null; }
function armTurn(s, now, turnMs) { s.turnDeadline = now + turnMs; }

/* ---------- joining ---------- */
export function join(s, { name, token }, now = Date.now()) {
  let p = playerByToken(s, token);
  if (!p) {
    if (token && !name) throw new TurkError("Your seat in this room is gone. Enter your name to join again.", "rejoin");
    const n = cleanName(name);
    if (!n.ok) throw new TurkError(n.error, "name");
    if (s.phase !== "lobby") throw new TurkError("This game has already started.", "started");
    if (active(s).length >= MAX_PLAYERS) throw new TurkError("This room is full (4 players max).", "full");
    p = { id: newId(), token: newToken(), name: n.name, ready: false, left: false, joinedAt: now, seen: now, rate: [] };
    s.players.push(p);
    cancelCountdown(s);
  }
  p.seen = now;
  if (!s.hostId || !active(s).some((x) => x.id === s.hostId)) s.hostId = p.id;
  return p;
}

/* ---------- timers: run on every request (there's no background clock on Pages) ---------- */
export function tick(s, now = Date.now(), opts = {}) {
  const turnMs = opts.turnMs || TURN_MS, nextMs = opts.nextMs || NEXT_ROUND_MS;
  let changed = false;
  // If nobody has been around for a while the clock was effectively paused: give timers a fresh start.
  if (now - (s.lastTick || now) > PAUSE_GAP_MS) {
    if (s.turnDeadline && s.turnDeadline < now) { s.turnDeadline = now + turnMs; changed = true; }
    if (s.nextRoundAt && s.nextRoundAt < now) { s.nextRoundAt = now + nextMs; changed = true; }
    if (s.countdownAt) { s.countdownAt = null; changed = true; }
  }
  s.lastTick = now;

  if (s.phase === "lobby") {
    // players who went offline in the lobby are un-readied so the game doesn't start without them
    for (const p of active(s)) if (p.ready && !online(p, now)) { p.ready = false; cancelCountdown(s); changed = true; }
    if (s.countdownAt && now >= s.countdownAt) {
      const ps = active(s);
      if (ps.length >= 2 && ps.every((p) => p.ready)) startGame(s, now, turnMs);
      else s.countdownAt = null;
      changed = true;
    }
  }
  if (s.phase === "game" && s.game) {
    const g = s.game;
    if (g.status === "playing" && s.turnDeadline && now >= s.turnDeadline) {
      const seq = g.round.turnSeq;
      Rules.autoTurn(g, Rules.currentPlayer(g));
      afterGameChange(s, now, seq, opts);
      changed = true;
    }
    if (g.status === "roundOver" && s.nextRoundAt && now >= s.nextRoundAt) { nextRound(s, now, turnMs); changed = true; }
  }
  if (s.hostId && !active(s).some((p) => p.id === s.hostId)) { pickHost(s, now); changed = true; }
  return changed;
}

/* ---------- actions ---------- */
export function act(s, me, msg, now = Date.now(), opts = {}) {
  const turnMs = opts.turnMs || TURN_MS;
  if (!msg || typeof msg.t !== "string") throw new TurkError("Bad message.");
  me.rate = (me.rate || []).filter((t) => now - t < RATE_WINDOW_MS);
  me.rate.push(now);
  if (me.rate.length > RATE_MAX) throw new TurkError("Slow down a little.");
  me.seen = now;
  try {
    switch (msg.t) {
      case "ready": setReady(s, me, !!msg.ready, now); break;
      case "leave": leave(s, me, now, opts); break;
      case "draw": play(s, me, now, opts, () => Rules.draw(s.game, me.id, msg.from)); break;
      case "spread": play(s, me, now, opts, () => Rules.layDown(s.game, me.id, msg.cards)); break;
      case "hit": play(s, me, now, opts, () => Rules.hit(s.game, me.id, msg.card, Number(msg.spread))); break;
      case "discard": play(s, me, now, opts, () => Rules.discard(s.game, me.id, msg.card)); break;
      case "drop": play(s, me, now, opts, () => Rules.drop(s.game, me.id)); break;
      case "continue": continueRound(s, me, now, turnMs); break;
      case "rematch": rematch(s, me); break;
      default: throw new TurkError("Unknown action.");
    }
  } catch (e) {
    if (e instanceof Rules.RuleError) throw new TurkError(e.message);
    throw e;
  }
}

function setReady(s, me, ready, now) {
  if (s.phase !== "lobby") throw new TurkError("The game has already started.");
  me.ready = ready;
  const ps = active(s);
  if (ps.length >= 2 && ps.every((p) => p.ready && online(p, now))) s.countdownAt = now + COUNTDOWN_MS;
  else cancelCountdown(s);
}

function leave(s, me, now, opts) {
  if (s.phase === "lobby") {
    s.players = s.players.filter((p) => p.id !== me.id);
    cancelCountdown(s);
  } else {
    me.left = true;
    Rules.removePlayer(s.game, me.id);
    afterGameChange(s, now, undefined, opts);
  }
  if (s.hostId === me.id) pickHost(s, now);
}

function startGame(s, now, turnMs) {
  s.game = Rules.newGame(active(s).map((p) => ({ id: p.id })));
  s.phase = "game";
  s.countdownAt = null;
  Rules.startRound(s.game);
  armTurn(s, now, turnMs);
}

function play(s, me, now, opts, fn) {
  const g = s.game;
  if (s.phase !== "game" || !g) throw new TurkError("The game hasn't started.");
  if (s.turnDeadline && now > s.turnDeadline + 250 && Rules.currentPlayer(g) === me.id) throw new TurkError("Time's up for this turn.");
  const seq = g.round && g.round.turnSeq;
  fn();
  afterGameChange(s, now, seq, opts);
}

function afterGameChange(s, now, prevSeq, opts = {}) {
  const g = s.game;
  if (!g) return;
  if (g.status === "playing") {
    if (prevSeq === undefined || g.round.turnSeq !== prevSeq) armTurn(s, now, opts.turnMs || TURN_MS);
  } else {
    s.turnDeadline = null;
    if (g.status === "roundOver") { s.nextRoundAt = now + (opts.nextMs || NEXT_ROUND_MS); s.continued = []; }
    else s.nextRoundAt = null;
  }
}

function continueRound(s, me, now, turnMs) {
  if (s.phase !== "game" || !s.game || s.game.status !== "roundOver") return;
  if (!s.continued.includes(me.id)) s.continued.push(me.id);
  const waiting = active(s).filter((p) => online(p, now) && !s.continued.includes(p.id));
  if (!waiting.length) nextRound(s, now, turnMs);
}
function nextRound(s, now, turnMs) {
  s.nextRoundAt = null;
  s.continued = [];
  Rules.startRound(s.game);
  armTurn(s, now, turnMs);
}
function rematch(s, me) {
  if (s.phase !== "game" || !s.game || s.game.status !== "over") return;
  s.players = s.players.filter((p) => !p.left);
  s.players.forEach((p) => { p.ready = p.id === me.id; });
  s.phase = "lobby";
  s.game = null;
  s.turnDeadline = null;
  s.nextRoundAt = null;
}

/* ---------- what each player is allowed to see ---------- */
export function viewFor(s, pid, now = Date.now(), version = 0, opts = {}) {
  const g = s.game;
  const players = s.players.filter((p) => !p.left || (g && g.seats.includes(p.id))).map((p) => ({
    id: p.id, name: p.name, ready: !!p.ready, connected: online(p, now), left: !!p.left, host: s.hostId === p.id,
  }));
  const view = {
    t: "state", now, version,
    room: { code: s.code, public: s.public, phase: s.phase, hostId: s.hostId, countdownAt: s.countdownAt, players, max: MAX_PLAYERS },
    you: pid, hand: [], game: null,
  };
  if (g) {
    const r = g.round;
    view.game = {
      status: g.status, roundNumber: g.roundNumber, roundsToWin: g.roundsToWin,
      seats: g.seats, score: g.score, roundsWon: g.roundsWon, winner: g.winner,
      turnDeadline: s.turnDeadline, nextRoundAt: s.nextRoundAt, continued: s.continued, turnMs: opts.turnMs || TURN_MS,
    };
    if (r) {
      Object.assign(view.game, {
        order: r.order, turn: g.status === "playing" ? Rules.currentPlayer(g) : null, step: r.step, turnSeq: r.turnSeq,
        stockCount: r.stock.length, discardTop: r.discard[r.discard.length - 1] || null, discardCount: r.discard.length,
        spreads: r.spreads,
        cardCounts: Object.fromEntries(r.order.map((id) => [id, (r.hands[id] || []).length])),
        tookDiscard: Rules.currentPlayer(g) === pid ? r.tookDiscard : null,
        // House rule: players have to remember what was discarded, so the move list never names discarded cards
        // (only the card currently on top of the pile is visible, like at a real table).
        log: r.log.map((e) => (e.t === "discard" || e.t === "draw" ? { t: e.t, by: e.by, from: e.from } : e)),
        result: r.result, // hands are only revealed once the round is over
      });
      if (r.hands[pid]) view.hand = r.hands[pid].slice();
    }
  }
  return view;
}

/* ---------- public-list summary ---------- */
export function summary(s, now = Date.now()) {
  const ps = active(s);
  const host = s.players.find((p) => p.id === s.hostId);
  return {
    phase: s.phase,
    playerCount: ps.length,
    hostName: host ? host.name : "",
    lastSeen: Math.max(0, ...ps.map((p) => p.seen || 0)),
    listed: s.public && s.phase === "lobby" && ps.length < MAX_PLAYERS && ps.some((p) => online(p, now)),
  };
}
