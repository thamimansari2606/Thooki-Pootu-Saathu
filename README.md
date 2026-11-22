# Thooki Pootu Saathu

A browser-based, cartoon, five-minute hide-and-tag survival game for up to six players.
Play alone against 1–5 AI bots, or online with friends in a private room.

- **Authoritative server.** Dice, catcher choice, damage, knockouts, the timer and the winner are all decided on the server.
- **Secret dice.** Each player picks a number from 1 to 6 in private. The dice roll until a pick matches; a random matching player becomes the catcher.
- **Human-like bots.** Five personalities (Runner, Hider, Dodger, Brave, Strategist) and three difficulties (Easy, Medium, Hard). Bots see only what a human could see.
- **Playable on desktop and phones.** Keyboard and mouse, or a touch joystick and buttons.

See [STATUS.md](STATUS.md) for exactly what is implemented, verified, substituted, and still missing.

## Repository layout

```
shared/            Arena geometry, collision and A* pathfinding (used by server, bots and client)
server/src/game/   Authoritative rules: dice.ts, room.ts (rooms), match.ts (match engine)
server/src/ai/     Bot AI: finite state machine, perception, personalities, difficulty
server/src/net/    HTTP + WebSocket server (gameServer.ts), input validation and rate limiting (validate.ts)
server/src/store/  Profile and match-history persistence (FileStore; SQL schema in migrations/)
server/migrations/ PostgreSQL schema (001_init.sql)
server/test/       Unit, simulation and integration tests (node:test)
client/src/        React app: screens, app store, network client, renderer, input, procedural audio
client/test/       Client logic tests (projection, interpolation, controls)
client/e2e/        Browser end-to-end tests (Playwright + Chrome)
render.yaml        Render blueprint for the server
vercel.json        Vercel build for the client
```

## Requirements

- Node.js 22.6 or newer (runs TypeScript directly with `--experimental-strip-types`)
- npm, for installing the `ws`, `react`, `react-dom` and `esbuild` packages
- Google Chrome or Chromium, only for the browser end-to-end tests

## Local setup

```bash
# 1. Install dependencies
(cd server && npm install)
(cd client && npm install)

# 2. Start the game server (port 8080, WebSocket at /ws, health at /health)
ALLOWED_ORIGINS=http://localhost:5173 npm run start:server

# 3. Build the client (points at the server; production needs GAME_SERVER_URL)
GAME_SERVER_URL=http://localhost:8080 npm run build:client
# Serve client/dist with any static server, e.g.:
npx --yes http-server client/dist -p 5173 -c-1
# Then open http://localhost:5173
```

## Tests

```bash
npm test               # server unit, simulation and integration tests, plus client logic tests
npm run typecheck:server
npm run test:e2e       # builds the client, starts its own server, and drives Chrome (set CHROME_PATH if needed)
```

Current results are listed in [STATUS.md](STATUS.md).

## Configuration

Server (environment variables, see `server/.env.example`):

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | Listen port (Render sets this) | `8080` |
| `ALLOWED_ORIGINS` | Comma-separated browser origins for CORS and the WebSocket origin check. Required in production. | none |
| `DATA_FILE` | JSON file for profiles and match history | `./data/store.json` |
| `TIME_SCALE` | Simulation sub-steps per tick. **Leave at 1 in production.** | `1` |

Client (build time, see `client/.env.example`):

| Variable | Purpose |
| --- | --- |
| `GAME_SERVER_URL` | https origin of the game server. The WebSocket URL is derived as `wss://<host>/ws`. Required for production builds. |

Nothing is hardcoded to a development URL in a production build.

## Deployment

**Server on Render.** `render.yaml` defines a Node web service with a health check at `/health` and a small persistent disk for the JSON store.
1. Create a Render Blueprint from this repository.
2. Set `ALLOWED_ORIGINS` to your Vercel URL (for example `https://thooki.vercel.app`).
3. Deploy. Note the service URL, for example `https://thooki-api.onrender.com`.

**Client on Vercel.** `vercel.json` builds `client/` into `client/dist`.
1. Import the repository in Vercel.
2. Set the environment variable `GAME_SERVER_URL` to the Render URL.
3. Deploy. The client connects to `wss://<render-host>/ws`.

**HTTPS and WebSockets.** Both hosts terminate TLS. Browsers require `wss://` from an `https://` page, which the build derives from `GAME_SERVER_URL`.

**Database.** Profiles and history are stored in a JSON file by default, which is suitable for one server instance. To move to PostgreSQL, apply `server/migrations/001_init.sql` to your database, then implement the `Store` interface in `server/src/store/store.ts` against it. The `pg` client package is not bundled here; see STATUS.md.

## Protocol (summary)

The client and server exchange JSON messages `{ "event": string, "data": object, "reqId"?: string }` over `/ws`.
Every request gets exactly one `ack` (with the same `reqId`) or `error` (with `code`).

Client → server: `hello`, `profile:update`, `room:create`, `room:join`, `room:ready`, `room:start`, `room:solo`, `room:pause`, `room:leave`, `match:select`, `match:input`, `match:prop`.

Server → client: `session`, `room:state`, `room:left`, `match:phase`, `match:dice`, `match:snapshot`, `match:events`, `match:paused`, `match:ended`, `error`.

Secrets: the reconnect token is sent only to its owner. Other players see a public ID derived from it with SHA-256. A player's secret number is never sent to anyone else, and the only public `value` fields are the rolled dice faces.

## Game rules

- A room holds up to six players. Two are needed to start. Everyone except the host must be ready.
- Every fighter starts with 100 HP. Only the catcher attacks, using one of three props: rod (10), hammer (20), slipper (10). The catcher switches props with 1, 2 and 3.
- Hits need range and a forward arc, and respect a cooldown per prop. A struck player is briefly invulnerable and knocked back.
- A match lasts 300 seconds. The catcher wins if every survivor is knocked out. The survivors win if at least one is still standing when time runs out.
- A player who disconnects keeps their seat for 30 seconds and can reconnect with their token. After that they are forfeited.

## Limitations of this build

This build runs in a sandbox where package installation from the npm registry was blocked by policy, so some of the originally specified stack is substituted. See STATUS.md for the full list. In short: Socket.IO → `ws` with the same event style; Three.js → a Canvas 2D isometric renderer; Vite and Tailwind → esbuild and plain CSS; PostgreSQL → a JSON store plus a schema ready to apply.
