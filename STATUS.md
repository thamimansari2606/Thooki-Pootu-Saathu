# Thooki Pootu Saathu: v2 status (honest)

## Verified in this sandbox
- Server tests: 106/106 pass (`npm run test:server`), including 7 PostgreSQL tests run against a real PostgreSQL 16 database (`TEST_DATABASE_URL=... node --experimental-strip-types --test server/test/postgres.test.ts`).
- PostgreSQL schema `server/migrations/001_init.sql` applied to PostgreSQL 16; `PostgresStore` writes matches idempotently and accumulates player statistics.
- Server typecheck: `tsc -p server/tsconfig.json` passes with no errors.
- Client tests: 14/14 pass.
- Browser end-to-end (Playwright + Chrome, desktop viewport): 6/6 scenarios pass (menu, single-player with easy AI, play again, multiplayer create/join/ready/secret picks, secret selections hidden from the other player, invalid room code rejected).
- Client production build: `GAME_SERVER_URL=... NODE_ENV=production node client/build.mjs` succeeds (app.js ~230 KB).
- Gameplay rules, five AI personalities, three difficulties and grid A* pathfinding are unchanged from v1 and covered by existing tests.

## Not done (blocked or not attempted)
- Three.js / React Three Fiber 3D rendering: NOT implemented. The client still uses the Canvas 2D isometric renderer.
- Socket.IO: NOT implemented. The server and client still use the custom `ws` JSON protocol at `/ws`.
- `pg` driver in production: `createPgClient` needs `npm install pg`; it is not installed in the sandbox, so the production path is untested. The psql-backed adapter was used for verification.
- Mobile browser emulation (joystick, Hit, Dodge, responsive layout): NOT run in v2.
- Loading screens, improved character animation, sound testing: NOT added in v2.
- Vercel and Render deployment: NOT performed. There is no network access or account here, so nothing is claimed as deployed.
- Server production bundle: not built; the server runs from TypeScript with `node --experimental-strip-types`.

## Install commands (run in an environment with npm access)
```
cd server && npm install ws pg && npm install -D typescript @types/node @types/ws
cd client && npm install react react-dom esbuild three @react-three/fiber @react-three/drei socket.io-client
cd server && npm install socket.io
psql "$DATABASE_URL" -f server/migrations/001_init.sql
```
