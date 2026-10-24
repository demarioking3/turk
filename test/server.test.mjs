/*
 * Multiplayer tests: real HTTP requests against the real Pages Function (functions/)
 * running in the local Pages stand-in, with a D1 look-alike. Covers joining, names, privacy of hands,
 * turns, the timer, reconnects, leaving, concurrency, access control and a full game.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./local-server.mjs";

let srv, base;
before(async () => {
  srv = await startServer(0, { TURK_TEST_TURN_MS: "1500", TURK_TEST_NEXT_MS: "800", TURK_POLL_MS: "1200" });
  base = `http://localhost:${srv.port}/api`;
});
after(async () => { await srv.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CARD_PTS = (c) => Math.min(10, ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"].indexOf(c.slice(0, -1)) + 1);

class Player {
  constructor(code) { this.code = code; this.token = ""; this.state = null; }
  async req(path, { method = "GET", body, headers = {} } = {}) {
    const r = await fetch(`${base}/rooms/${this.code}${path}`, {
      method, headers: { "X-Turk-Token": this.token, ...(body ? { "content-type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = r.status === 204 ? null : await r.json();
    return { status: r.status, data };
  }
  async join(name, token) {
    const r = await this.req("/join", { method: "POST", body: { name, token } });
    if (r.status === 200) { this.id = r.data.id; this.token = r.data.token; this.state = r.data.state; }
    return r;
  }
  async act(msg) {
    const r = await this.req("/act", { method: "POST", body: msg });
    if (r.status === 200) this.state = r.data.state;
    return r;
  }
  /** Fetch the latest state (returns quickly if anything is newer than `since`). */
  async refresh(since = -1) {
    const r = await this.req(`/state?since=${since}`);
    if (r.status === 200) this.state = r.data.state;
    return r;
  }
  async until(pred, ms = 6000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await this.refresh(-1);
      if (this.state && pred(this.state)) return this.state;
      await sleep(120);
    }
    throw new Error("timed out waiting");
  }
}

async function newRoom(isPublic = false, headers = {}) {
  const r = await fetch(base + "/rooms", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ public: isPublic }) });
  return r.status === 200 ? (await r.json()).code : r.status;
}
async function startedGame(names) {
  const code = await newRoom();
  const ps = [];
  for (const n of names) { const p = new Player(code); assert.equal((await p.join(n)).status, 200); ps.push(p); }
  for (const p of ps) await p.act({ t: "ready", ready: true });
  await sleep(3100);
  for (const p of ps) await p.until((s) => s.room.phase === "game");
  return { code, ps };
}
const turnOf = (ps) => ps.find((p) => p.id === ps[0].state.game.turn);

test("room codes: create, look up, unknown code is 404", async () => {
  const code = await newRoom();
  assert.match(code, /^[A-Z2-9]{5}$/);
  const ok = await fetch(`${base}/rooms/${code}`);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).phase, "lobby");
  assert.equal((await fetch(`${base}/rooms/ZZZZZ`)).status, 404);
  assert.equal((await fetch(`${base}/rooms/%3Cscript%3E`)).status, 404);
});

test("names: validated on the server, duplicates allowed with unique IDs, max 4 players", async () => {
  const code = await newRoom();
  for (const n of ["", "   ", "<b>hi</b>", "x".repeat(21), null]) {
    const r = await new Player(code).join(n);
    assert.equal(r.status, 400, `should reject ${JSON.stringify(n)}`);
  }
  const ps = [];
  for (const n of ["  Mike  ", "Mike", "Dee", "Tasha"]) { const p = new Player(code); assert.equal((await p.join(n)).status, 200); ps.push(p); }
  await ps[0].refresh();
  const names = ps[0].state.room.players;
  assert.deepEqual(names.map((p) => p.name), ["Mike", "Mike", "Dee", "Tasha"]);
  assert.equal(new Set(names.map((p) => p.id)).size, 4);
  const r = await new Player(code).join("Fifth");
  assert.equal(r.status, 400);
  assert.match(r.data.error, /full/);
});

test("other sites can't create rooms or act; tokens are required", async () => {
  assert.equal(await newRoom(false, { Origin: "https://evil.example" }), 403);
  const code = await newRoom();
  const a = new Player(code); await a.join("A");
  const evil = await a.req("/act", { method: "POST", body: { t: "ready", ready: true }, headers: { Origin: "https://evil.example" } });
  assert.equal(evil.status, 403);
  const stranger = new Player(code);
  assert.equal((await stranger.act({ t: "ready", ready: true })).status, 403);
  assert.equal((await stranger.refresh()).status, 403);
  stranger.token = "0".repeat(48);
  assert.equal((await stranger.refresh()).status, 403, "a made-up token gets nothing");
});

test("ready-up: starts only when 2+ players are all ready; late joiners are turned away", async () => {
  const code = await newRoom();
  const a = new Player(code); await a.join("A");
  await a.act({ t: "ready", ready: true });
  assert.equal(a.state.room.countdownAt, null, "one player can't start");
  const b = new Player(code); await b.join("B");
  await b.act({ t: "ready", ready: true });
  assert.ok(b.state.room.countdownAt > b.state.now);
  await sleep(3100);
  await a.until((s) => s.room.phase === "game");
  const late = await new Player(code).join("Late");
  assert.equal(late.status, 400);
  assert.match(late.data.error, /already started/);
});

test("4 players: 5 cards each, hands private, 52 cards accounted for", async () => {
  const { ps } = await startedGame(["Mike", "Mike", "Dee", "Tasha"]);
  for (const p of ps) await p.refresh();
  const all = [];
  for (const p of ps) {
    assert.equal(p.state.hand.length, 5);
    all.push(...p.state.hand);
    const raw = JSON.stringify(p.state);
    assert.ok(!raw.includes('"token"'), "tokens never leave the server");
    for (const o of ps) if (o !== p) for (const c of o.state.hand) if (c !== p.state.game.discardTop) assert.ok(!raw.includes(`"${c}"`), `${c} leaked`);
  }
  const g = ps[0].state.game;
  assert.equal(new Set(all).size, 20);
  assert.equal(all.length + g.stockCount + g.discardCount, 52);
});

test("turns: only the current player acts, one draw per turn, same names stay distinct", async () => {
  const { ps } = await startedGame(["Sam", "Sam"]);
  await ps[0].refresh();
  const cur = turnOf(ps), other = ps.find((p) => p !== cur);
  assert.match((await other.act({ t: "draw", from: "stock" })).data.error, /not your turn/);
  assert.match((await cur.act({ t: "discard", card: cur.state.hand[0] })).data.error, /Draw a card first/);
  assert.equal((await cur.act({ t: "draw", from: "stock" })).status, 200);
  assert.equal(cur.state.hand.length, 6);
  assert.match((await cur.act({ t: "draw", from: "discard" })).data.error, /already drawn/);
  assert.equal((await cur.act({ t: "spread", cards: ["AS", "KS", "QS"] })).status, 400);
  const card = cur.state.hand.find((c) => c !== cur.state.game.tookDiscard);
  await cur.act({ t: "discard", card });
  const st = await other.until((s) => s.game.turn === other.id);
  assert.equal(st.game.discardTop, card);
  assert.notEqual(cur.id, other.id);
});

test("a waiting player hears about a move right away (long poll)", async () => {
  const { ps } = await startedGame(["Wait", "Move"]);
  await ps[0].refresh();
  const cur = turnOf(ps), watcher = ps.find((p) => p !== cur);
  await watcher.refresh();
  const since = watcher.state.version;
  const t0 = Date.now();
  const pending = watcher.req(`/state?since=${since}`);
  await sleep(250);
  await cur.act({ t: "draw", from: "stock" });
  const r = await pending;
  assert.equal(r.status, 200);
  assert.ok(r.data.state.version > since);
  assert.ok(Date.now() - t0 < 1200, "answered when the move happened, not at the timeout");
});

test("simultaneous actions don't overwrite each other", async () => {
  const code = await newRoom();
  const ps = [];
  for (const n of ["A", "B", "C", "D"]) { const p = new Player(code); await p.join(n); ps.push(p); }
  await Promise.all(ps.map((p) => p.act({ t: "ready", ready: true })));
  await ps[0].refresh();
  assert.ok(ps[0].state.room.players.every((p) => p.ready), "all four ready flags survived");
});

test("timer: an expired turn is auto-played and the game moves on", async () => {
  const { ps } = await startedGame(["Ana", "Ben", "Cy"]);
  await ps[0].refresh();
  const first = turnOf(ps);
  const st = await ps[1].until((s) => s.game.turn !== first.id, 5000);
  assert.ok(st.game.log.some((e) => e.t === "timeout" && e.by === first.id));
  assert.equal(st.game.cardCounts[first.id], 5);
});

test("reconnect keeps the same seat, name and hand", async () => {
  const { code, ps } = await startedGame(["Rio", "Kai"]);
  const [a] = ps;
  await a.refresh();
  const hand = a.state.hand.slice().sort();
  const again = new Player(code);
  const r = await again.join(undefined, a.token);
  assert.equal(r.status, 200);
  assert.equal(again.id, a.id);
  assert.equal(again.state.room.players.find((p) => p.id === a.id).name, "Rio");
  if (again.state.game.status === "playing" && again.state.hand.length === hand.length) assert.deepEqual(again.state.hand.slice().sort(), hand);
  const forged = await new Player(code).join(undefined, "0".repeat(48));
  assert.equal(forged.status, 403);
});

test("leaving mid-game: the others keep playing; last one standing wins", async () => {
  const { ps } = await startedGame(["One", "Two", "Three"]);
  const [a, b, c] = ps;
  await a.act({ t: "leave" });
  const st = await b.until((s) => !s.game.order.includes(a.id));
  assert.equal(st.game.status, "playing");
  await b.act({ t: "leave" });
  const end = await c.until((s) => s.game.status === "over");
  assert.equal(end.game.winner, c.id);
  assert.equal((await a.refresh()).status, 403, "a player who left can't peek");
});

test("rate limiting: flooding gets throttled", async () => {
  const code = await newRoom();
  const a = new Player(code); await a.join("Spam");
  let throttled = false;
  for (let i = 0; i < 40 && !throttled; i++) {
    const r = await a.act({ t: "ready", ready: i % 2 === 0 });
    if (r.status === 400 && /Slow down/.test(r.data.error)) throttled = true;
  }
  assert.ok(throttled);
});

test("public rooms are listed while open", async () => {
  const code = await newRoom(true);
  const a = new Player(code); await a.join("Public Pat");
  const list = await (await fetch(base + "/rooms")).json();
  const mine = list.rooms.find((r) => r.code === code);
  assert.ok(mine);
  assert.equal(mine.host, "Public Pat");
  const priv = await newRoom(false);
  await new Player(priv).join("Hidden");
  const again = await (await fetch(base + "/rooms")).json();
  assert.ok(!again.rooms.find((r) => r.code === priv), "private rooms are never listed");
});

test("full game: DROP rounds until someone wins 3; scores add up", async () => {
  const { ps } = await startedGame(["Ace", "Bee", "Cee", "Dee"]);
  for (let round = 0; round < 15; round++) {
    await ps[0].refresh();
    const g = ps[0].state.game;
    if (g.status === "over") break;
    if (g.status === "playing") {
      const cur = turnOf(ps);
      await cur.act({ t: "drop" });
      const done = cur.state.game;
      const r = done.result;
      assert.ok(["drop", "tunk"].includes(r.how));
      for (const id of done.order) assert.equal(r.points[id], r.hands[id].reduce((t, c) => t + CARD_PTS(c), 0));
      if (done.status === "roundOver") {
        const n = done.roundNumber;
        for (const p of ps) await p.act({ t: "continue" });
        await ps[0].until((s) => s.game.roundNumber === n + 1);
      }
    }
  }
  const g = ps[0].state.game;
  assert.equal(g.status, "over");
  assert.equal(g.roundsWon[g.winner], 3);
  for (const p of ps) { await p.refresh(); assert.equal(p.state.game.winner, g.winner); }
  await ps[0].act({ t: "rematch" });
  const lobby = await ps[1].until((s) => s.room.phase === "lobby");
  assert.equal(lobby.room.players.length, 4);
});

test("without the database binding the API says so clearly", async () => {
  const { onRequest } = await import("../functions/api/[[path]].js");
  const r = await onRequest({ request: new Request("http://x/api/rooms"), env: {} });
  assert.equal(r.status, 503);
});

test("discarded cards are never named in the move list (players must remember them)", async () => {
  const { ps } = await startedGame(["Mem", "Ory"]);
  await ps[0].refresh();
  const cur = turnOf(ps), other = ps.find((p) => p !== cur);
  await cur.act({ t: "draw", from: "stock" });
  const card = cur.state.hand[cur.state.hand.length - 1];
  await cur.act({ t: "discard", card });
  await other.act({ t: "draw", from: "discard" });
  for (const p of ps) {
    await p.refresh();
    const log = p.state.game.log;
    const disc = log.find((e) => e.t === "discard");
    assert.ok(disc && !("card" in disc), "discard entry has no card");
    const took = log.find((e) => e.t === "draw" && e.from === "discard");
    assert.ok(took && !("card" in took), "pick-up entry has no card");
  }
});

test("'still here' heartbeats don't redraw other players' screens", async () => {
  const code = await newRoom();
  const a = new Player(code), b = new Player(code);
  await a.join("Quiet"); await b.join("Still");
  await a.refresh();
  const rev = a.state.version;
  await sleep(5200);                      // b's heartbeat becomes due
  await b.req(`/state?since=${rev}`);     // b checks in (saves a heartbeat)
  const r = await a.req(`/state?since=${rev}`);
  assert.equal(r.status, 204, "nothing visible changed, so a gets 'no news'");
});
