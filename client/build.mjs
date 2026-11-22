// Production build for the static frontend (Vercel). Bundles with esbuild and writes dist/.
//   GAME_SERVER_URL   https origin of the game server, e.g. https://thooki-api.onrender.com
// The WebSocket URL is derived from it (https -> wss, http -> ws). Nothing is hardcoded.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const serverOrigin = (process.env.GAME_SERVER_URL ?? "http://localhost:8080").replace(/\/$/, "");
const wsUrl = serverOrigin.replace(/^http/, "ws") + "/ws";
const minify = process.env.NODE_ENV === "production";

if (process.env.NODE_ENV === "production" && !process.env.GAME_SERVER_URL) {
  console.error("GAME_SERVER_URL must be set for production builds.");
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(here, "src/main.tsx")],
  bundle: true,
  outfile: join(dist, "app.js"),
  format: "esm",
  target: ["es2020"],
  jsx: "automatic",
  minify,
  sourcemap: !minify,
  define: {
    __WS_URL__: JSON.stringify(wsUrl),
    __HTTP_URL__: JSON.stringify(serverOrigin),
    "process.env.NODE_ENV": JSON.stringify(minify ? "production" : "development"),
  },
  loader: { ".ts": "ts", ".tsx": "tsx" },
  logLevel: "info",
});

for (const f of ["index.html", "src/styles.css"]) {
  copyFileSync(join(here, f), join(dist, f.split("/").pop()));
}
console.log(`Built client to ${dist} (server: ${serverOrigin})`);
