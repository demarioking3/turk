import test from "node:test";
import assert from "node:assert/strict";
import * as T from "../functions/_lib/rules.js";
import { resolveDrop, DROP_RULES } from "../functions/_lib/drop-rules.js";
import { cleanName, MAX_NAME_LENGTH } from "../functions/_lib/names.js";

const P = (n) => Array.from({ length: n }, (_, i) => ({ id: "p" + (i + 1) }));

/** A game mid-round with exact hands / piles, p1 to play. */
function rig(hands, { stock = ["2C", "3C", "4C", "5C"], discard = ["9D"], spreads = [] } = {}) {
  const ids = Object.keys(hands);
  const g = T.newGame(ids.map((id) => ({ id })));
  T.startRound(g);
  const r = g.round;
  r.order = ids; r.turn = 0; r.step = "draw";
  r.hands = JSON.parse(JSON.stringify(hands));
  r.stock = stock.slice(); r.discard = discard.slice();
  r.spreads = JSON.parse(JSON.stringify(spreads)); r.nextSpreadId = spreads.length + 1;
  r.hasPlayed = Object.fromEntries(ids.map((id) => [id, false]));
  return g;
}

/* ---- deck integrity ---- */
test("deck: 52 unique cards, no jokers", () => {
  const d = T.newDeck();
  assert.equal(d.length, 52);
  assert.equal(new Set(d).size, 52);
  assert.ok(d.every(T.isCard));
  assert.ok(!d.some((c) => /jok/i.test(c)));
});

test("deal: exactly 5 each, top card to discard, no card in two places", () => {
  for (const n of [2, 3, 4]) {
    for (let k = 0; k < 20; k++) {
      const g = T.startRound(T.newGame(P(n)));
      const r = g.round;
      const all = [...Object.values(r.hands).flat(), ...r.stock, ...r.discard];
      assert.equal(all.length, 52);
      assert.equal(new Set(all).size, 52);
      for (const id of r.order) assert.equal(r.hands[id].length, 5);
      assert.equal(r.discard.length, 1);
      assert.equal(r.stock.length, 52 - 5 * n - 1);
    }
  }
});

test("first player is random", () => {
  const firsts = new Set();
  for (let k = 0; k < 60; k++) firsts.add(T.startRound(T.newGame(P(4))).round.order[0]);
  assert.equal(firsts.size, 4);
});

/* ---- card values ---- */
test("card points: A=1, 2–10 face value, J/Q/K=10", () => {
  assert.equal(T.points("AS"), 1);
  for (let v = 2; v <= 10; v++) assert.equal(T.points(v + "H"), v);
  for (const c of ["JC", "QS", "KH"]) assert.equal(T.points(c), 10);
  assert.equal(T.handPoints(["AS", "KD", "7H"]), 18);
});

/* ---- combinations ---- */
test("runs: 3+ same suit in a row accepted, Ace low only", () => {
  assert.equal(T.spreadKind(["AH", "2H", "3H"]), "run");
  assert.equal(T.spreadKind(["4S", "5S", "6S", "7S"]), "run");
  assert.equal(T.spreadKind(["9D", "10D", "JD"]), "run");
  assert.equal(T.spreadKind(["JD", "9D", "10D"]), "run", "order in hand doesn't matter");
});
test("invalid runs rejected", () => {
  assert.equal(T.spreadKind(["QS", "KS", "AS"]), null, "no high Ace");
  assert.equal(T.spreadKind(["4H", "5S", "6H"]), null, "mixed suits");
  assert.equal(T.spreadKind(["4H", "6H", "7H"]), null, "gap");
  assert.equal(T.spreadKind(["4H", "5H"]), null, "too short");
  assert.equal(T.spreadKind(["4H", "4H", "5H"]), null, "duplicate card");
});
test("sets: 3–4 of a kind accepted; invalid sets rejected", () => {
  assert.equal(T.spreadKind(["7H", "7S", "7D"]), "set");
  assert.equal(T.spreadKind(["KH", "KS", "KD", "KC"]), "set");
  assert.equal(T.spreadKind(["AH", "AS", "AC"]), "set");
  assert.equal(T.spreadKind(["7H", "7S"]), null);
  assert.equal(T.spreadKind(["7H", "7S", "8D"]), null);
  assert.equal(T.spreadKind(["7H", "7H", "7S"]), null, "same physical card twice");
  assert.equal(T.spreadKind(["7H", "7S", "XX"]), null);
});

/* ---- turn progression ---- */
test("must draw first; only one draw; discard ends the turn", () => {
  const g = rig({ p1: ["4H", "5H", "6H", "9C", "KS"], p2: ["2D", "3D", "8S", "9S", "QH"] });
  assert.throws(() => T.discard(g, "p1", "KS"), /Draw a card first/);
  assert.throws(() => T.draw(g, "p2", "stock"), /not your turn/);
  T.draw(g, "p1", "stock");
  assert.throws(() => T.draw(g, "p1", "stock"), /already drawn/);
  assert.throws(() => T.draw(g, "p1", "discard"), /already drawn/);
  T.discard(g, "p1", "KS");
  assert.equal(T.currentPlayer(g), "p2");
  assert.equal(g.round.discard.at(-1), "KS");
  assert.throws(() => T.discard(g, "p1", "9C"), /not your turn/);
});

test("can draw from either pile (top of discard only)", () => {
  const g = rig({ p1: ["4H", "5H", "6H", "9C", "KS"], p2: ["2D", "3D", "8S", "9S", "QH"] }, { discard: ["2S", "JD"] });
  T.draw(g, "p1", "discard");
  assert.ok(g.round.hands.p1.includes("JD"));
  assert.deepEqual(g.round.discard, ["2S"]);
  assert.throws(() => T.discard(g, "p1", "JD"), /throw back/);
  T.discard(g, "p1", "KS");
  T.draw(g, "p2", "stock");
  assert.equal(g.round.hands.p2.length, 6);
});

test("laying down is optional — you can keep a run hidden", () => {
  const g = rig({ p1: ["4H", "5H", "6H", "9C", "KS"], p2: ["2D", "3D", "8S", "9S", "QH"] });
  T.draw(g, "p1", "stock");
  T.discard(g, "p1", "KS");
  assert.equal(g.round.spreads.length, 0);
  assert.ok(["4H", "5H", "6H"].every((c) => g.round.hands.p1.includes(c)));
});

test("can't lay down or play cards you don't hold", () => {
  const g = rig({ p1: ["4H", "5H", "9C", "9S", "KS"], p2: ["6H", "3D", "8S", "9H", "QH"] });
  T.draw(g, "p1", "stock");
  assert.throws(() => T.layDown(g, "p1", ["4H", "5H", "6H"]), /isn't in your hand/);
  assert.deepEqual(g.round.hands.p1.slice(0, 5), ["4H", "5H", "9C", "9S", "KS"], "hand unchanged after a failed move");
});

/* ---- playing on other players' spreads ---- */
test("add cards to other players' runs (either end) and sets", () => {
  const spreads = [
    { id: 1, owner: "p2", kind: "run", cards: ["7H", "8H", "9H"] },
    { id: 2, owner: "p2", kind: "set", cards: ["7C", "7S", "7D"] },
  ];
  const g = rig({ p1: ["6H", "10H", "7H", "2S", "9C"], p2: ["2D", "3D", "8S", "JS", "QH"] }, { spreads });
  g.round.spreads[1].cards = ["7C", "7S", "7D"];
  g.round.hands.p1 = ["6H", "10H", "2S", "9C", "KD"];
  T.draw(g, "p1", "stock");
  T.hit(g, "p1", "6H", 1);
  T.hit(g, "p1", "10H", 1);
  assert.deepEqual(g.round.spreads[0].cards, ["6H", "7H", "8H", "9H", "10H"]);
  assert.throws(() => T.hit(g, "p1", "9C", 1), /doesn't fit/);
  assert.throws(() => T.hit(g, "p1", "2S", 2), /doesn't fit/);
});
test("a set can't grow past four", () => {
  const spreads = [{ id: 1, owner: "p2", kind: "set", cards: ["KH", "KS", "KD"] }];
  const g = rig({ p1: ["KC", "2S", "3S", "9C", "9S"], p2: ["2D", "3D", "8S", "JS", "QH"] }, { spreads });
  T.draw(g, "p1", "stock");
  T.hit(g, "p1", "KC", 1);
  assert.equal(g.round.spreads[0].cards.length, 4);
  assert.equal(T.canHit(g.round.spreads[0], "KH"), false);
});

/* ---- ending a round ---- */
test("emptying your hand wins the round immediately", () => {
  const g = rig({ p1: ["4H", "5H", "6H", "9C", "9S"], p2: ["2D", "3D", "8S", "JS", "QH"], p3: ["AC", "AD", "8C", "JC", "QC"] }, { stock: ["9D"] });
  T.draw(g, "p1", "stock");
  T.layDown(g, "p1", ["4H", "5H", "6H"]);
  T.layDown(g, "p1", ["9C", "9S", "9D"]);
  const res = g.round.result;
  assert.equal(g.status, "roundOver");
  assert.equal(res.how, "out");
  assert.deepEqual(res.winners, ["p1"]);
  assert.equal(res.points.p1, 0);
  assert.equal(g.score.p2, 33);
  assert.equal(g.roundsWon.p1, 1);
  assert.throws(() => T.discard(g, "p2", "2D"), /no round in progress/);
});

test("discarding your last card also goes out", () => {
  const g = rig({ p1: ["4H", "5H", "6H", "7H"], p2: ["2D", "3D", "8S", "JS", "QH"] }, { stock: ["9D"] });
  T.draw(g, "p1", "stock");
  T.layDown(g, "p1", ["4H", "5H", "6H", "7H"]);
  T.discard(g, "p1", "9D");
  assert.equal(g.round.result.how, "out");
});

/* ---- DROP ---- */
test("DROP: strictly lowest hand wins; every hand is scored", () => {
  const g = rig({ p1: ["AS", "2H", "3D", "AC", "2C"], p2: ["KD", "QH", "2S", "9D", "3S"], p3: ["KC", "QC", "JC", "9C", "8C"] });
  T.draw(g, "p1", "stock"); // after drawing is fine too
  T.drop(g, "p1");
  const res = g.round.result;
  assert.equal(res.how, "drop");
  assert.equal(res.caught, false);
  assert.deepEqual(res.winners, ["p1"]);
  assert.equal(res.points.p2, 34);
  assert.equal(res.points.p3, 47);
  assert.equal(g.score.p3, 47);
  assert.equal(g.score.p1, 0, "winner's own hand isn't added");
});

test("DROP caught: someone ties or beats the dropper → they win, dropper takes the penalty", () => {
  const g = rig({ p1: ["5S", "5H", "3D", "AC", "2C"], p2: ["AD", "AH", "2S", "3H", "9D"], p3: ["KC", "QC", "JC", "9C", "8C"] }); // 16 vs 16
  T.drop(g, "p1");
  const res = g.round.result;
  assert.equal(res.caught, true);
  assert.deepEqual(res.winners, ["p2"]);
  assert.equal(g.score.p1, 16 + DROP_RULES.CAUGHT_PENALTY);
  assert.equal(g.roundsWon.p2, 1);
  assert.equal(g.score.p2, 0, "the round winner adds nothing");
  assert.equal(g.score.p3, 47);
});

test("DROP tie between other players = tied round, no round win", () => {
  const r = resolveDrop("p1", { p1: 20, p2: 9, p3: 9 });
  assert.equal(r.caught, true);
  assert.deepEqual(r.winners, ["p2", "p3"]);
  const g = rig({ p1: ["KS", "QS", "9H"], p2: ["AD", "2H"], p3: ["AS", "2C"] });
  T.drop(g, "p1");
  assert.equal(g.round.result.tie, true);
  assert.equal(g.roundsWon.p2 + g.roundsWon.p3, 0);
});

test("DROP only on your own turn, and only once", () => {
  const g = rig({ p1: ["AS", "2H", "3D", "AC", "2C"], p2: ["KD", "QH", "2S", "9D", "3S"] });
  assert.throws(() => T.drop(g, "p2"), /not your turn/);
  T.drop(g, "p1");
  assert.throws(() => T.drop(g, "p1"), /no round in progress/);
});

test("21 Tunk: dealt 21, dropped on first turn before drawing → instant win", () => {
  const g = rig({ p1: ["AS", "2H", "3D", "5C", "10S"], p2: ["AD", "AH", "2C", "2D", "3S"] }); // p1 = 21, p2 = 9
  T.drop(g, "p1");
  assert.equal(g.round.result.how, "tunk");
  assert.deepEqual(g.round.result.winners, ["p1"]);
  assert.equal(g.score.p1, 0);
});
test("21 after drawing, or after the first turn, is just a normal drop", () => {
  let g = rig({ p1: ["AS", "2H", "3D", "5C", "10S"], p2: ["AD", "AH", "2C", "2D", "3S"] });
  g.round.hasPlayed.p1 = true;
  T.drop(g, "p1");
  assert.equal(g.round.result.how, "drop");
  assert.equal(g.round.result.caught, true);

  g = rig({ p1: ["AS", "2H", "3D", "5C", "9S"], p2: ["AD", "AH", "2C", "2D", "3S"] }, { stock: ["AC"] }); // 20 + A = 21 after draw
  T.draw(g, "p1", "stock");
  T.drop(g, "p1");
  assert.equal(g.round.result.how, "drop");
});

/* ---- timeouts / deck running out ---- */
test("timeout auto-play: draws, discards the highest card, passes the turn", () => {
  const g = rig({ p1: ["AS", "2H", "3D", "AC", "KC"], p2: ["KD", "QH", "2S", "9D", "3S"] }, { stock: ["2C", "4D"] });
  const seq = g.round.turnSeq;
  T.autoTurn(g, "p1");
  assert.equal(T.currentPlayer(g), "p2");
  assert.equal(g.round.discard.at(-1), "KC");
  assert.equal(g.round.hands.p1.length, 5);
  assert.equal(g.round.turnSeq, seq + 1);
  T.autoTurn(g, "p1"); // stale timer for someone whose turn it isn't: no effect
  assert.equal(T.currentPlayer(g), "p2");
});

test("empty deck reshuffles the discard pile, keeping its top card", () => {
  const g = rig({ p1: ["AS", "2H", "3D", "AC", "KC"], p2: ["KD", "QH", "2S", "9D", "3S"] },
    { stock: ["4D"], discard: ["5C", "6C", "7C", "8C"] });
  T.draw(g, "p1", "stock");
  T.discard(g, "p1", "KC");
  const r = g.round;
  assert.equal(r.reshuffles, 1);
  assert.deepEqual(r.discard, ["KC"]);
  assert.deepEqual(r.stock.slice().sort(), ["5C", "6C", "7C", "8C"].sort());
  const all = [...Object.values(r.hands).flat(), ...r.stock, ...r.discard];
  assert.equal(new Set(all).size, all.length);
});

test("deck AND discard exhausted: round ends, lowest hand wins (fallback)", () => {
  const g = rig({ p1: ["KS", "QS", "9H", "8C", "7D"], p2: ["AD", "AH", "2S", "3H", "4C"] }, { stock: ["6S"], discard: [] });
  T.draw(g, "p1", "stock");
  T.discard(g, "p1", "KS");
  assert.equal(g.round.result.how, "stock");
  assert.deepEqual(g.round.result.winners, ["p2"]);
});

/* ---- game end / leaving ---- */
test("first to 3 round wins takes the game", () => {
  const g = T.newGame(P(2));
  for (let i = 0; i < T.ROUNDS_TO_WIN; i++) {
    T.startRound(g);
    const r = g.round;
    r.order = ["p1", "p2"]; r.turn = 0; r.step = "play";
    r.hands.p1 = ["4H", "5H", "6H"];
    T.layDown(g, "p1", ["4H", "5H", "6H"]);
  }
  assert.equal(g.status, "over");
  assert.equal(g.winner, "p1");
  assert.equal(T.ROUNDS_TO_WIN, 3);
  assert.equal(g.roundsWon.p1, 3);
});

test("a player leaving mid-round doesn't corrupt the game", () => {
  const g = T.startRound(T.newGame(P(3)));
  const leaving = T.currentPlayer(g);
  T.removePlayer(g, leaving);
  const r = g.round;
  assert.equal(r.order.length, 2);
  assert.notEqual(T.currentPlayer(g), leaving);
  const all = [...Object.values(r.hands).flat(), ...r.stock, ...r.discard];
  assert.equal(all.length, 52);
  assert.equal(new Set(all).size, 52);
  T.removePlayer(g, r.order[0]);
  assert.equal(g.status, "over");
  assert.equal(g.winner, r.order[0]);
});

/* ---- names ---- */
test("names: trimmed, max length, safe characters only, no HTML", () => {
  assert.deepEqual(cleanName("  Big   Mike  "), { ok: true, name: "Big Mike" });
  assert.equal(cleanName("   ").ok, false);
  assert.equal(cleanName("").ok, false);
  assert.equal(cleanName(null).ok, false);
  assert.equal(cleanName("x".repeat(MAX_NAME_LENGTH)).ok, true);
  assert.equal(cleanName("x".repeat(MAX_NAME_LENGTH + 1)).ok, false);
  assert.equal(cleanName("<script>alert(1)</script>").ok, false);
  assert.equal(cleanName('Mo"><img src=x>').ok, false);
  assert.equal(cleanName("José O'Neil #1!").ok, true);
  assert.equal(cleanName("DJ_K-9 & Co.").ok, true);
});
