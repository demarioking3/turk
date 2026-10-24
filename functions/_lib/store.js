/*
 * TURK rooms in Cloudflare D1 (binding TURK_DB).
 * Each room is one row holding its JSON state plus a version number. Writes only succeed if the version
 * hasn't changed since the read (optimistic locking), so two players acting at the same moment can never
 * overwrite each other — the loser simply retries against the fresh state.
 */
import { summary } from "./room.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS turk_rooms (
     code TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
     is_public INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL DEFAULT 'lobby', open_seats INTEGER NOT NULL DEFAULT 4,
     host_name TEXT NOT NULL DEFAULT '', player_count INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS turk_rooms_public ON turk_rooms (is_public, phase, last_seen)`,
];
const STALE_ROOM_MS = 24 * 60 * 60_000; // rooms nobody has touched for a day are deleted
let schemaReady = false;

export async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of SCHEMA) await db.prepare(sql).run();
  schemaReady = true;
}

export async function load(db, code) {
  const row = await db.prepare("SELECT state, version FROM turk_rooms WHERE code = ?").bind(code).first();
  return row ? { s: JSON.parse(row.state), version: row.version } : null;
}

export async function insert(db, code, s, now = Date.now()) {
  const m = summary(s, now);
  const res = await db.prepare(
    `INSERT OR IGNORE INTO turk_rooms (code, state, version, is_public, phase, open_seats, host_name, player_count, created_at, updated_at, last_seen)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(code, JSON.stringify(s), s.public ? 1 : 0, m.phase, m.listed ? 1 : 0, m.hostName, m.playerCount, now, now, now).run();
  return res.meta && res.meta.changes === 1;
}

/** Save if nobody else wrote in between. Returns the new version, or null if it lost the race. */
export async function save(db, code, s, version, now = Date.now()) {
  const m = summary(s, now);
  const res = await db.prepare(
    `UPDATE turk_rooms SET state = ?, version = version + 1, phase = ?, open_seats = ?, host_name = ?, player_count = ?,
       updated_at = ?, last_seen = ? WHERE code = ? AND version = ?`
  ).bind(JSON.stringify(s), m.phase, m.listed ? 1 : 0, m.hostName, m.playerCount, now, Math.max(m.lastSeen, 0) || now, code, version).run();
  return res.meta && res.meta.changes === 1 ? version + 1 : null;
}

/**
 * Load → change → save, retrying on a conflict. `fn(s, now)` returns { changed, result } (or throws).
 * Returns { s, version, result }.
 */
export async function update(db, code, fn) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await load(db, code);
    if (!cur) return null;
    const now = Date.now();
    const out = fn(cur.s, now) || {};
    if (!out.changed) return { s: cur.s, version: cur.version, result: out.result };
    const v = await save(db, code, cur.s, cur.version, now);
    if (v !== null) return { s: cur.s, version: v, result: out.result };
    await new Promise((r) => setTimeout(r, 15 + Math.random() * 40));
  }
  throw new Error("Too many players acting at once — try again.");
}

export async function listPublic(db, now = Date.now()) {
  const { results } = await db.prepare(
    `SELECT code, host_name, player_count FROM turk_rooms
     WHERE is_public = 1 AND phase = 'lobby' AND open_seats = 1 AND last_seen > ?
     ORDER BY updated_at DESC LIMIT 30`
  ).bind(now - 30_000).all();
  return results.map((r) => ({ code: r.code, host: r.host_name, players: r.player_count }));
}

export async function cleanup(db, now = Date.now()) {
  await db.prepare("DELETE FROM turk_rooms WHERE last_seen < ?").bind(now - STALE_ROOM_MS).run();
}
