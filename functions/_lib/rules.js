/*
 * TURK — game rules (pure logic, no networking). The server is the only place this runs.
 *
 * - 52-card deck, no jokers. 2–4 players, 5 cards each. Top card of the deck starts the discard pile.
 * - Card points: Ace = 1, 2–10 = face value, J/Q/K = 10.
 * - First player each round is chosen at random.
 * - Turn: draw one card (top of the deck or top of the discard pile), then optionally lay down spreads
 *   and/or add cards to ANY player's spread, then discard one card. Laying down is optional.
 *   DROP may be pressed at any point in your own turn (see drop-rules.js).
 * - Spreads: three or four of a kind, or a run of 3+ cards in one suit (Ace is low only: A-2-3).
 * - Going out: empty your hand → you win the round immediately.
 * - Deck runs out: the discard pile (minus its top card) is shuffled into a new deck.
 *   If that's impossible (only one discard), the round ends and the lowest hand wins.
 * - Scoring: every player except the round winner adds the points left in their hand to their running score
 *   (lower is better). In a tied round everyone adds their hand.
 *   The round winner gets a round win. First to ROUNDS_TO_WIN round wins takes the game.
 */
import { DROP_RULES, resolveDrop, isTunk } from "./drop-rules.js";

export const HAND_SIZE = 5;
export const ROUNDS_TO_WIN = 3;
export const SUITS = ["S", "H", "D", "C"];
export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
export { DROP_RULES };

export class RuleError extends Error {}
function fail(msg) { throw new RuleError(msg); }

/* ---------- randomness: cryptographically secure by default ---------- */
export function secureRandom() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] / 4294967296;
}

/* ---------- cards ---------- */
export function rankOf(card) { return card.slice(0, -1); }
export function suitOf(card) { return card.slice(-1); }
export function rankValue(card) { return RANKS.indexOf(rankOf(card)) + 1; } // A=1 … K=13
export function points(card) { return Math.min(10, rankValue(card)); }
export function handPoints(hand) { return hand.reduce((t, c) => t + points(c), 0); }
export function isCard(c) { return typeof c === "string" && SUITS.includes(suitOf(c)) && RANKS.includes(rankOf(c)); }

export function newDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  return d;
}
export function shuffle(arr, rng = secureRandom) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ---------- spreads ---------- */
export function spreadKind(cards) {
  if (!Array.isArray(cards) || cards.length < 3 || !cards.every(isCard)) return null;
  if (new Set(cards).size !== cards.length) return null;
  const r = rankOf(cards[0]);
  if (cards.length <= 4 && cards.every((c) => rankOf(c) === r)) return "set";
  const s = suitOf(cards[0]);
  if (!cards.every((c) => suitOf(c) === s)) return null;
  const v = cards.map(rankValue).sort((a, b) => a - b);
  for (let i = 1; i < v.length; i++) if (v[i] !== v[i - 1] + 1) return null;
  return "run";
}
export function sortSpread(kind, cards) {
  if (kind === "run") return cards.slice().sort((a, b) => rankValue(a) - rankValue(b));
  return cards.slice().sort((a, b) => SUITS.indexOf(suitOf(a)) - SUITS.indexOf(suitOf(b)));
}
export function canHit(spread, card) {
  if (!isCard(card) || spread.cards.includes(card)) return false;
  if (spread.kind === "set") return spread.cards.length < 4 && rankOf(card) === rankOf(spread.cards[0]);
  if (suitOf(card) !== suitOf(spread.cards[0])) return false;
  const lo = rankValue(spread.cards[0]), hi = rankValue(spread.cards[spread.cards.length - 1]);
  const v = rankValue(card);
  return v === lo - 1 || v === hi + 1;
}

/* ---------- game setup ---------- */
/** players: [{id}] in seat order. */
export function newGame(players) {
  if (players.length < 2 || players.length > 4) fail("TURK needs 2 to 4 players.");
  const ids = players.map((p) => p.id);
  return {
    status: "playing",               // playing | roundOver | over
    seats: ids,
    left: {},                        // players who quit mid-game
    score: Object.fromEntries(ids.map((id) => [id, 0])),
    roundsWon: Object.fromEntries(ids.map((id) => [id, 0])),
    roundsToWin: ROUNDS_TO_WIN,
    roundNumber: 0,
    round: null,
    winner: null,
  };
}

export function activeSeats(game) { return game.seats.filter((id) => !game.left[id]); }

export function startRound(game, rng = secureRandom) {
  const seats = activeSeats(game);
  if (seats.length < 2) fail("Not enough players to deal.");
  game.status = "playing";
  game.roundNumber += 1;
  const first = Math.floor(rng() * seats.length);
  const order = seats.slice(first).concat(seats.slice(0, first));
  const deck = shuffle(newDeck(), rng);
  const hands = {};
  for (const id of order) hands[id] = [];
  for (let n = 0; n < HAND_SIZE; n++) for (const id of order) hands[id].push(deck.pop());
  game.round = {
    order,
    turn: 0,
    step: "draw",        // "draw" = must draw (or drop); "play" = may spread / hit / discard / drop
    turnSeq: 1,          // increases every turn; used to ignore stale timer callbacks
    hands,
    stock: deck,
    discard: [deck.pop()],
    spreads: [],
    nextSpreadId: 1,
    hasPlayed: Object.fromEntries(order.map((id) => [id, false])),
    tookDiscard: null,
    reshuffles: 0,
    log: [{ t: "deal", first: order[0] }],
    result: null,
  };
  return game;
}

/* ---------- helpers ---------- */
function R(game) {
  if (!game.round || game.status !== "playing") fail("There's no round in progress.");
  return game.round;
}
export function currentPlayer(game) {
  const r = game.round;
  return r && game.status === "playing" ? r.order[r.turn] : null;
}
function requireTurn(game, pid, step) {
  const r = R(game);
  if (currentPlayer(game) !== pid) fail("It's not your turn.");
  if (step && r.step !== step) fail(step === "draw" ? "You've already drawn this turn." : "Draw a card first.");
  return r;
}
function takeFromHand(hand, cards) {
  const copy = hand.slice();
  for (const c of cards) {
    const i = copy.indexOf(c);
    if (i === -1) fail("That card isn't in your hand.");
    copy.splice(i, 1);
  }
  hand.length = 0;
  hand.push(...copy);
}
function log(r, entry) { r.log.push(entry); if (r.log.length > 30) r.log.shift(); }

/* ---------- actions ---------- */
export function draw(game, pid, from, rng = secureRandom) {
  const r = requireTurn(game, pid, "draw");
  if (from === "discard") {
    if (!r.discard.length) fail("The discard pile is empty.");
    const c = r.discard.pop();
    r.hands[pid].push(c);
    r.tookDiscard = c;
    log(r, { t: "draw", by: pid, from: "discard", card: c });
  } else if (from === "stock") {
    if (!r.stock.length) refillStock(r, rng);
    if (!r.stock.length) fail("The deck is empty.");
    r.hands[pid].push(r.stock.pop());
    r.tookDiscard = null;
    log(r, { t: "draw", by: pid, from: "stock" });
  } else fail("Draw from the deck or the discard pile.");
  r.step = "play";
  return game;
}

export function layDown(game, pid, cards) {
  const r = requireTurn(game, pid, "play");
  const kind = spreadKind(cards);
  if (!kind) fail("That isn't a valid spread. Use three or four of a kind, or 3+ cards in a row of the same suit.");
  takeFromHand(r.hands[pid], cards);
  const spread = { id: r.nextSpreadId++, owner: pid, kind, cards: sortSpread(kind, cards) };
  r.spreads.push(spread);
  log(r, { t: "spread", by: pid, kind, cards: spread.cards });
  if (!r.hands[pid].length) endRound(game, { how: "out", by: pid });
  return game;
}

export function hit(game, pid, card, spreadId) {
  const r = requireTurn(game, pid, "play");
  const spread = r.spreads.find((s) => s.id === spreadId);
  if (!spread) fail("That spread isn't on the table.");
  if (!r.hands[pid].includes(card)) fail("That card isn't in your hand.");
  if (!canHit(spread, card)) fail("That card doesn't fit on that spread.");
  takeFromHand(r.hands[pid], [card]);
  spread.cards = sortSpread(spread.kind, spread.cards.concat(card));
  log(r, { t: "hit", by: pid, card, owner: spread.owner });
  if (!r.hands[pid].length) endRound(game, { how: "out", by: pid });
  return game;
}

export function discard(game, pid, card, rng = secureRandom) {
  const r = requireTurn(game, pid, "play");
  if (!r.hands[pid].includes(card)) fail("That card isn't in your hand.");
  if (card === r.tookDiscard && r.hands[pid].length > 1) fail("You can't throw back the card you just picked up.");
  takeFromHand(r.hands[pid], [card]);
  r.discard.push(card);
  log(r, { t: "discard", by: pid, card });
  r.hasPlayed[pid] = true;
  if (!r.hands[pid].length) { endRound(game, { how: "out", by: pid }); return game; }
  advance(game, rng);
  return game;
}

export function drop(game, pid) {
  const r = requireTurn(game, pid);
  const hand = r.hands[pid];
  const tunk = isTunk({ handTotal: handPoints(hand), handSize: hand.length, isFirstTurn: !r.hasPlayed[pid], hasDrawn: r.step !== "draw" });
  endRound(game, { how: tunk ? "tunk" : "drop", by: pid });
  return game;
}

/** Time ran out (or the player is disconnected): draw from the deck if needed, then throw the highest card. */
export function autoTurn(game, pid, rng = secureRandom) {
  const r = R(game);
  if (currentPlayer(game) !== pid) return game;
  if (r.step === "draw") {
    if (!r.stock.length) refillStock(r, rng);
    if (r.stock.length) draw(game, pid, "stock", rng);
    else if (r.discard.length) draw(game, pid, "discard", rng);
  }
  if (game.status !== "playing") return game;
  const hand = r.hands[pid].slice().sort((a, b) => points(b) - points(a) || rankValue(b) - rankValue(a));
  const pick = hand.find((c) => c !== r.tookDiscard) || hand[0];
  log(r, { t: "timeout", by: pid });
  discard(game, pid, pick, rng);
  return game;
}

function refillStock(r, rng) {
  if (r.discard.length <= 1) return;
  const top = r.discard.pop();
  r.stock = shuffle(r.discard, rng);
  r.discard = [top];
  r.reshuffles += 1;
  log(r, { t: "reshuffle" });
}

function advance(game, rng) {
  const r = game.round;
  r.turn = (r.turn + 1) % r.order.length;
  r.step = "draw";
  r.turnSeq += 1;
  r.tookDiscard = null;
  if (!r.stock.length) refillStock(r, rng);
  if (!r.stock.length && r.discard.length <= 1) endRound(game, { how: "stock" }); // documented fallback
}

/* ---------- round end & scoring ---------- */
function endRound(game, { how, by = null }) {
  const r = game.round;
  const pts = Object.fromEntries(r.order.map((id) => [id, handPoints(r.hands[id])]));
  let winners = [];
  let caught = false;
  let penalty = {};

  if (how === "out" || how === "tunk") {
    winners = [by];
  } else if (how === "drop") {
    ({ winners, caught, penalty } = resolveDrop(by, pts));
  } else {
    const low = Math.min(...r.order.map((id) => pts[id]));
    winners = r.order.filter((id) => pts[id] === low);
  }
  const tie = winners.length !== 1;
  const added = {};
  for (const id of r.order) {
    // the round winner's hand doesn't count against them; everyone else adds what they're holding
    added[id] = (!tie && winners[0] === id ? 0 : pts[id]) + (penalty[id] || 0);
    game.score[id] += added[id];
  }
  if (!tie) game.roundsWon[winners[0]] += 1;

  r.result = {
    how, by, caught, winners, tie,
    points: pts,
    added,
    hands: Object.fromEntries(r.order.map((id) => [id, r.hands[id].slice()])),
  };
  r.step = "done";
  log(r, { t: "end", how, by, winners, caught, tie });

  const champ = !tie && game.roundsWon[winners[0]] >= game.roundsToWin ? winners[0] : null;
  if (champ) { game.status = "over"; game.winner = champ; }
  else game.status = "roundOver";
}

/** A player quits mid-game: their cards go under the discard pile and they're skipped from now on. */
export function removePlayer(game, pid, rng = secureRandom) {
  if (!game.seats.includes(pid) || game.left[pid]) return game;
  game.left[pid] = true;
  const r = game.round;
  if (r && game.status === "playing") {
    const idx = r.order.indexOf(pid);
    if (idx !== -1) {
      const wasTurn = idx === r.turn;
      r.discard.unshift(...r.hands[pid]);
      delete r.hands[pid];
      r.order.splice(idx, 1);
      if (idx < r.turn) r.turn -= 1;
      if (r.turn >= r.order.length) r.turn = 0;
      if (wasTurn) { r.step = "draw"; r.tookDiscard = null; r.turnSeq += 1; }
      log(r, { t: "left", by: pid });
    }
  }
  const left = activeSeats(game);
  if (left.length < 2) {
    game.status = "over";
    game.winner = left[0] || null;
    if (r) r.step = "done";
  }
  return game;
}
