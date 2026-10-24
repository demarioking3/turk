# TURK — multiplayer card game

**Play:** https://turk.demarioking.com (linked from the Game Zone on https://demarioking.com)

TURK has its own Cloudflare **Pages** project (`turk`, root directory = this repo's root).
Every push to `main` redeploys it. It's independent of the main website.

## Where the files are

| Path | What it is |
|---|---|
| `site/` | The game page: HTML, CSS, JS, images, favicon, and security headers (`_headers`). |
| `site/audio/` | Put `turk-lobby.mp3` and `turk-table.mp3` here (optional). |
| `functions/api/[[path]].js` | The game server: a Pages Function that handles everything under `/api/`. |
| `functions/_lib/` | Rules (`rules.js`), DROP/bluff rules (`drop-rules.js`), names, room logic and database code. |
| `wrangler.jsonc` | Pages settings, including the `TURK_DB` database binding. |
| `test/` | Automated tests and a local stand-in for Cloudflare Pages. |

## Cloudflare setup (one time)

- **Pages project:** `turk`, connected to this GitHub repo, production branch `main`, build command empty, build output `site`.
- **Database binding:** `TURK_DB` → D1 database `turk-game` (set in `wrangler.jsonc`; if the dashboard asks, add it under Settings → Bindings).
- **Custom domain:** `turk.demarioking.com` (Custom domains tab). Cloudflare creates the DNS record automatically.

No secrets or API keys are used anywhere.

## How multiplayer works

- Each room is one row in a free Cloudflare **D1** database called `turk-game` (binding `TURK_DB`). The table is created automatically.
- The server is the only source of truth. It handles who's in the room, shuffling (cryptographically secure), dealing, private hands,
  turn order, the 30-second timer, every draw/spread/discard/DROP, and scoring. Each browser only ever receives that player's own cards.
- Browsers send moves with normal web requests and listen for updates by "long polling": they ask "anything new?" and the server answers
  as soon as something changes (checking every half second, for up to 20 seconds per request).
- Writes use version numbers, so two players acting at the same moment can never overwrite each other.
- Timers run whenever anyone in the room checks in. If everyone leaves for a while, the clock pauses and restarts fresh when they come back.
- Each player gets a secret token, stored in their browser, so reloading or reconnecting keeps the same seat, name and cards.
  No account, email or real name is needed.

## Rules (as built)

- 52 cards, no jokers. 5 cards each. Ace = 1, 2–10 = face value, J/Q/K = 10. The first player each round is random. Each turn lasts 30 seconds.
- Draw from the deck or take the top discard, then optionally lay down spreads or add to anyone's spreads, then discard one card.
- Spreads: three or four of a kind, or 3+ in a row of one suit (Ace is low only).
- Empty your hand → you win the round.
- **DROP** (any time in your own turn): everyone reveals their hand and the lowest hand wins. If anyone ties or beats the dropper,
  the dropper is caught and takes a 10-point penalty.
- **21 Tunk:** if your dealt 5 cards total exactly 21 and you DROP on your first turn before drawing, you win instantly. Nobody is told their total.
- When the deck runs out, the discard pile (minus its top card) is reshuffled into a new deck. If that's impossible, the lowest hand wins.
- Everyone except the round winner adds the points left in their hand to their score. **First to win 3 rounds wins the game.**
- If a turn runs out of time, the game draws for the player and discards their highest card.

Settings to change later: `ROUNDS_TO_WIN` and `HAND_SIZE` in `rules.js`, `CAUGHT_PENALTY` and `TUNK_TOTAL` in `drop-rules.js`,
and `TURN_MS` in `room.js`.

## Testing

Needs Node.js 22.13 or newer. No install step is needed.

```
npm test          # 44 checks: deck, spreads, turns, scoring, DROP/Tunk, timer, privacy, reconnects, concurrency, access control
npm run local     # serves the game at http://localhost:8788/
```
