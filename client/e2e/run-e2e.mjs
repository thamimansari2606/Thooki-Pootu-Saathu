// End-to-end tests: real server + built client + Chrome via Playwright.
// Requirements: Chrome/Chromium (CHROME_PATH), Playwright (PLAYWRIGHT_MODULE, default: 'playwright').
// Run from the repository root: node client/e2e/run-e2e.mjs
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = join(root, "client", "dist");
const chromePath = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const pwModule = process.env.PLAYWRIGHT_MODULE ?? "playwright";
const require = createRequire(join(root, "client", "package.json"));
let chromium;
try {
  ({ chromium } = require(pwModule));
} catch {
  ({ chromium } = createRequire("/opt/npm-tools/node_modules/")("playwright"));
}

const SERVER_PORT = Number(process.env.E2E_SERVER_PORT ?? 18180);
const STATIC_PORT = Number(process.env.E2E_STATIC_PORT ?? 18181);
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const STATIC_URL = `http://127.0.0.1:${STATIC_PORT}`;

function run(cmd, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}\n${out}`))));
  });
}

async function waitFor(url, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function staticServer() {
  const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".map": "application/json" };
  return createServer((req, res) => {
    const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    const file = join(dist, path);
    if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  }).listen(STATIC_PORT, "127.0.0.1");
}

const tmp = mkdtempSync(join(tmpdir(), "tps-e2e-"));
let server;
let statics;
let browser;
const results = [];

async function scenario(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   - ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`FAIL - ${name}\n       ${e.message.split("\n").slice(0, 4).join("\n       ")}`);
  }
}

async function newPage(errors, label) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 760 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("404")) errors.push(`${label} console: ${m.text()}`);
  });
  await page.goto(`${STATIC_URL}/index.html`, { waitUntil: "load" });
  await page.waitForTimeout(500);
  return page;
}

try {
  await run("node", ["build.mjs"], { GAME_SERVER_URL: SERVER_URL }, join(root, "client"));
  server = spawn("node", ["--experimental-strip-types", "src/index.ts"], {
    cwd: join(root, "server"),
    env: { ...process.env, PORT: String(SERVER_PORT), TIME_SCALE: "20", ALLOWED_ORIGINS: STATIC_URL, DATA_FILE: join(tmp, "store.json") },
    stdio: "ignore",
  });
  statics = staticServer();
  await waitFor(`${SERVER_URL}/health`);
  await waitFor(`${STATIC_URL}/index.html`);
  browser = await chromium.launch({ executablePath: chromePath, args: ["--no-sandbox"] });

  await scenario("menu loads with the title and name field and no page errors", async () => {
    const errors = [];
    const page = await newPage(errors, "menu");
    assert.match(await page.title(), /Thooki Pootu Saathu/);
    assert.ok(await page.isVisible("input[placeholder='Player name']"));
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  await scenario("single player: choose 2 opponents and easy, then secret pick, roll, match and end screen", async () => {
    const errors = [];
    const page = await newPage(errors, "single");
    await page.fill("input[placeholder='Player name']", "Solo Tester");
    await page.getByRole("button", { name: "Single Player" }).click();
    await page.getByRole("button", { name: "2 opponents" }).click();
    await page.getByRole("button", { name: "easy" }).click();
    await page.getByRole("button", { name: "Start game" }).click();
    await page.getByRole("button", { name: "Pick 4" }).click({ timeout: 10000 });
    await page.waitForSelector(".game canvas", { timeout: 30000 });
    await page.keyboard.down("ArrowLeft");
    await page.waitForTimeout(400);
    await page.keyboard.up("ArrowLeft");
    await page.keyboard.press("KeyJ");
    await page.waitForSelector(".end .headline", { timeout: 120000 });
    const headline = await page.textContent(".end .headline");
    assert.ok(/win/i.test(headline), `headline: ${headline}`);
    const rows = await page.locator(".rankings li").count();
    assert.equal(rows, 3, "rankings list the human and two bots");
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  await scenario("single player: play again starts a fresh match with the same opponents", async () => {
    const errors = [];
    const page = await newPage(errors, "replay");
    await page.fill("input[placeholder='Player name']", "Replayer");
    await page.getByRole("button", { name: "Single Player" }).click();
    await page.getByRole("button", { name: "1 opponent" }).click();
    await page.getByRole("button", { name: "easy" }).click();
    await page.getByRole("button", { name: "Start game" }).click();
    await page.getByRole("button", { name: "Pick 1" }).click({ timeout: 10000 });
    await page.waitForSelector(".end .headline", { timeout: 120000 });
    await page.getByRole("button", { name: "Play again" }).click();
    await page.getByRole("button", { name: "Pick 3" }).click({ timeout: 15000 });
    await page.waitForSelector(".game canvas", { timeout: 30000 });
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  await scenario("multiplayer: create, join by code, ready, secret picks, and both players see the same end", async () => {
    const errors = [];
    const host = await newPage(errors, "host");
    const guest = await newPage(errors, "guest");
    await host.fill("input[placeholder='Player name']", "Host");
    await guest.fill("input[placeholder='Player name']", "Guest");
    await host.getByRole("button", { name: "Multiplayer" }).click();
    await host.getByRole("button", { name: "Create private room" }).click();
    await host.waitForSelector(".slots", { timeout: 10000 });
    const code = (await host.textContent(".panel-title")).replace("Room ", "").trim();
    assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
    await guest.getByRole("button", { name: "Multiplayer" }).click();
    await guest.fill(".code-input", code);
    await guest.getByRole("button", { name: "Join" }).click();
    await guest.waitForSelector(".slots", { timeout: 10000 });
    await guest.getByRole("button", { name: "I'm ready" }).click();
    await host.waitForFunction(() => document.querySelectorAll(".slot.ready").length >= 1, null, { timeout: 10000 });
    await host.getByRole("button", { name: "Start match" }).click();
    await host.getByRole("button", { name: "Pick 2" }).click({ timeout: 10000 });
    await guest.getByRole("button", { name: "Pick 5" }).click({ timeout: 10000 });
    await host.waitForSelector(".game canvas", { timeout: 30000 });
    await guest.waitForSelector(".game canvas", { timeout: 30000 });
    await host.waitForSelector(".end .headline", { timeout: 120000 });
    await guest.waitForSelector(".end .headline", { timeout: 30000 });
    const hostRows = await host.textContent(".rankings");
    const guestRows = await guest.textContent(".rankings");
    assert.equal(hostRows.replace(/\s+/g, " "), guestRows.replace(/\s+/g, " "), "both players see identical rankings");
    assert.deepEqual(errors, []);
    await host.context().close();
    await guest.context().close();
  });

  await scenario("secret selections are not visible to the other player", async () => {
    const errors = [];
    const host = await newPage(errors, "host2");
    const guest = await newPage(errors, "guest2");
    await host.fill("input[placeholder='Player name']", "Secret A");
    await guest.fill("input[placeholder='Player name']", "Secret B");
    await host.getByRole("button", { name: "Multiplayer" }).click();
    await host.getByRole("button", { name: "Create private room" }).click();
    await host.waitForSelector(".slots", { timeout: 10000 });
    const code = (await host.textContent(".panel-title")).replace("Room ", "").trim();
    await guest.getByRole("button", { name: "Multiplayer" }).click();
    await guest.fill(".code-input", code);
    await guest.getByRole("button", { name: "Join" }).click();
    await guest.waitForSelector(".slots", { timeout: 10000 });
    await guest.getByRole("button", { name: "I'm ready" }).click();
    await host.waitForFunction(() => document.querySelectorAll(".slot.ready").length >= 1, null, { timeout: 10000 });
    await host.getByRole("button", { name: "Start match" }).click();
    await host.getByRole("button", { name: "Pick 6" }).click({ timeout: 10000 });
    await guest.waitForSelector("text=Chosen so far: 1 of 2", { timeout: 10000 });
    const guestBody = await guest.textContent("body");
    assert.ok(!guestBody.includes("You picked 6"), "guest must not learn the host's choice");
    assert.ok(guestBody.includes("Chosen so far: 1 of 2"), "guest sees only a count");
    await host.context().close();
    await guest.context().close();
  });

  await scenario("the join screen rejects an invalid room code before contacting the server", async () => {
    const errors = [];
    const page = await newPage(errors, "badcode");
    await page.fill("input[placeholder='Player name']", "Typo");
    await page.getByRole("button", { name: "Multiplayer" }).click();
    await page.fill(".code-input", "ABC");
    await page.getByRole("button", { name: "Join" }).click();
    await page.waitForSelector("text=Room codes are 6 characters.", { timeout: 5000 });
    await page.context().close();
  });
} catch (e) {
  console.error("E2E setup failed:", e.message);
  results.push({ name: "setup", ok: false, error: e.message });
} finally {
  if (browser) await browser.close();
  if (statics) statics.close();
  if (server) server.kill();
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser scenarios passed`);
process.exit(failed.length ? 1 : 0);
