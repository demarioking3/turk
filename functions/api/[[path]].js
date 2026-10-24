/*
 * TURK game API (Cloudflare Pages Function) — everything under /api/.
 *
 *   GET  /api/rooms                    open public rooms
 *   POST /api/rooms                    create a room → { code }
 *   GET  /api/rooms/CODE               does this room exist / can I join?
 *   POST /api/rooms/CODE/join          { name, token? } → { id, token, state }
 *   POST /api/rooms/CODE/act           { t: "draw" | "discard" | ... } → { state }
 *   GET  /api/rooms/CODE/state?since=V waits (up to ~20s) for a visible change newer than revision V
 *
 * The player's secret token travels in the X-Turk-Token header. Rooms live in D1 (binding TURK_DB).
 */
import * as Room from "../_lib/room.js";
import * as Store from "../_lib/store.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;
const POLL_STEP_MS = 500;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function newCode() {
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  return [...b].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
}
function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}
async function body(request) {
  const text = await request.text();
  if (text.length > 2000) throw new Room.TurkError("Message too large.");
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new Room.TurkError("Bad message."); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function options(env) {
  return { turnMs: Number(env.TURK_TEST_TURN_MS) || undefined, nextMs: Number(env.TURK_TEST_NEXT_MS) || undefined };
}

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.TURK_DB;
  if (!db) return json({ error: "The game server isn't set up yet (missing database)." }, 503);
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = request.method;
  const opts = options(env);

  try {
    await Store.ensureSchema(db);
    if (method === "POST" && !sameOrigin(request)) return json({ error: "Forbidden" }, 403);

    // /rooms
    if (parts[0] !== "rooms") return json({ error: "Not found" }, 404);
    if (parts.length === 1) {
      if (method === "GET") return json({ rooms: await Store.listPublic(db) });
      if (method === "POST") {
        const b = await body(request);
        const now = Date.now();
        for (let i = 0; i < 6; i++) {
          const code = newCode();
          if (await Store.insert(db, code, Room.newRoom(code, b.public === true, now), now)) {
            if (Math.random() < 0.05) context.waitUntil?.(Store.cleanup(db));
            return json({ code });
          }
        }
        return json({ error: "Couldn't create a room. Try again." }, 503);
      }
      return json({ error: "Method not allowed" }, 405);
    }

    const code = parts[1].toUpperCase();
    if (!CODE_RE.test(code)) return json({ exists: false, error: "No room with that code." }, 404);

    // /rooms/CODE
    if (parts.length === 2 && method === "GET") {
      const cur = await Store.load(db, code);
      if (!cur) return json({ exists: false, error: "No room with that code." }, 404);
      const m = cur.s.players.filter((p) => !p.left).length;
      return json({ exists: true, phase: cur.s.phase, players: m, max: Room.MAX_PLAYERS });
    }

    const action = parts[2];
    const token = request.headers.get("X-Turk-Token") || "";

    // /rooms/CODE/join
    if (action === "join" && method === "POST") {
      const b = await body(request);
      const out = await Store.update(db, code, (s, now) => {
        Room.tick(s, now, opts);
        const p = Room.join(s, { name: b.name, token: typeof b.token === "string" ? b.token : "" }, now);
        s.rev = (s.rev || 0) + 1;
        return { changed: true, result: p };
      });
      if (!out) return json({ error: "No room with that code.", code: "gone" }, 404);
      const p = out.result;
      return json({ id: p.id, token: p.token, code, state: Room.viewFor(out.s, p.id, Date.now(), out.s.rev || 0, opts) });
    }

    // /rooms/CODE/act
    if (action === "act" && method === "POST") {
      const msg = await body(request);
      const out = await Store.update(db, code, (s, now) => {
        const me = Room.playerByToken(s, token);
        if (!me) throw new Room.TurkError("You're not in this room.", "rejoin");
        Room.tick(s, now, opts);
        Room.act(s, me, msg, now, opts);
        s.rev = (s.rev || 0) + 1;
        return { changed: true, result: me.id };
      });
      if (!out) return json({ error: "No room with that code.", code: "gone" }, 404);
      return json({ state: Room.viewFor(out.s, out.result, Date.now(), out.s.rev || 0, opts) });
    }

    // /rooms/CODE/state?since=V  (long poll)
    if (action === "state" && method === "GET") {
      const since = Number(url.searchParams.get("since")) || 0;
      const waitMs = Math.min(25_000, Number(env.TURK_POLL_MS) || 20_000);
      const until = Date.now() + waitMs;
      for (;;) {
        const out = await Store.update(db, code, (s, now) => {
          const me = Room.playerByToken(s, token);
          if (!me) throw new Room.TurkError("You're not in this room.", "rejoin");
          let changed = Room.tick(s, now, opts);
          if (changed) s.rev = (s.rev || 0) + 1; // a timer fired: everyone needs the new state
          // "still here" heartbeat: saved, but it isn't a visible change, so nobody's screen is redrawn for it
          if (now - (me.seen || 0) > 5_000) { me.seen = now; changed = true; }
          return { changed, result: me.id };
        });
        if (!out) return json({ error: "That game has ended or the room was closed.", code: "gone" }, 404);
        const rev = out.s.rev || 0;
        if (rev > since || Date.now() >= until || request.signal?.aborted) {
          if (rev <= since) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
          return json({ state: Room.viewFor(out.s, out.result, Date.now(), rev, opts) });
        }
        await sleep(POLL_STEP_MS);
      }
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    if (e instanceof Room.TurkError) return json({ error: e.message, code: e.code }, e.code === "rejoin" ? 403 : 400);
    console.error(e);
    return json({ error: "The game server hit a problem. Please try again." }, 500);
  }
}
