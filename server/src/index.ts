// Server entry point. Configuration comes from environment variables; nothing is hardcoded.
//   PORT               listen port (Render sets this)            default 8080
//   ALLOWED_ORIGINS    comma-separated browser origins for CORS and WebSocket origin checks
//   DATABASE_URL       PostgreSQL connection string (preferred in production; apply migrations first)
//   DATA_FILE          JSON persistence file used when DATABASE_URL is unset  default ./data/store.json
//   TIME_SCALE         simulation sub-steps per tick (leave at 1 in production)
import { FileStore, PostgresStore, type Store } from "./store/store.ts";
import { createPgClient } from "./store/sql.ts";
import { startGameServer } from "./net/gameServer.ts";

const port = Number(process.env.PORT ?? 8080);
const rawOrigins = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const allowedOrigins = rawOrigins.length === 1 && rawOrigins[0] === "*" ? "*" : rawOrigins;
const dataFile = process.env.DATA_FILE ?? "./data/store.json";
const timeScale = Number(process.env.TIME_SCALE ?? 1);

if (process.env.NODE_ENV === "production" && allowedOrigins !== "*" && allowedOrigins.length === 0) {
  console.error("ALLOWED_ORIGINS must be set in production (comma-separated frontend origins).");
  process.exit(1);
}

// DATABASE_URL selects PostgreSQL (requires `npm install pg`); otherwise the JSON file store is used.
const store: Store = process.env.DATABASE_URL
  ? new PostgresStore(await createPgClient(process.env.DATABASE_URL))
  : new FileStore(dataFile);
console.log(`persistence: ${process.env.DATABASE_URL ? "postgres" : `json file (${dataFile})`}`);
const server = await startGameServer(port, { store, allowedOrigins, timeScale });
console.log(`Thooki Pootu Saathu server listening on :${server.port} (health: /health, socket: /ws)`);

const shutdown = async (signal: string) => {
  console.log(`${signal} received, shutting down`);
  await server.close();
  await store.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
