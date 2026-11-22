// End-to-end protocol tests: real HTTP + WebSocket server, real clients over the network.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startGameServer, type RunningGameServer } from "../src/net/gameServer.ts";
import { MemoryStore } from "../src/store/store.ts";

type Msg = { event: string; data?: any; reqId?: string };

class Client {
  sock: WebSocket;
  inbox: Msg[] = [];
  waiters: Array<{ pred: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];
  token: string | null = null;
  publicId: string | null = null;
  private reqSeq = 0;

  constructor(url: string) {
    this.sock = new WebSocket(url);
    this.sock.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as Msg;
      const w = this.waiters.find((x) => x.pred(m));
      if (w) {
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve(m);
      } else {
        this.inbox.push(m);
      }
    });
  }

  open(): Promise<void> {
    return new Promise((res, rej) => {
      this.sock.once("open", () => res());
      this.sock.once("error", rej);
    });
  }

  send(event: string, data: unknown = {}): string {
    const reqId = `r${++this.reqSeq}`;
    this.sock.send(JSON.stringify({ event, data, reqId }));
    return reqId;
  }

  /** Waits for a message matching pred, including ones already received. */
  wait(pred: (m: Msg) => boolean, timeoutMs = 4000): Promise<Msg> {
    const idx = this.inbox.findIndex(pred);
    if (idx >= 0) return Promise.resolve(this.inbox.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  }

  /** The most recent room:state received, if any. */
  latestRoom(): any | null {
    for (let i = this.inbox.length - 1; i >= 0; i--) {
      if (this.inbox[i].event === "room:state") return this.inbox[i].data;
    }
    return null;
  }

  /** Waits for a reply to a specific request (ack or error with the same reqId). */
  reply(reqId: string): Promise<Msg> {
    return this.wait((m) => m.reqId === reqId && (m.event === "ack" || m.event === "error"));
  }

  close(): void {
    this.sock.terminate();
  }
}

/** Collects `value` fields not belonging to a public dice_roll event. */
function findValueFieldsOutsideRolls(msgs: Msg[]): unknown[] {
  const leaks: unknown[] = [];
  const walk = (node: unknown, inRoll: boolean) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, inRoll));
    if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      const isRoll = o.type === "dice_roll";
      if ("value" in o && !(inRoll || isRoll)) leaks.push(o.value);
      for (const v of Object.values(o)) walk(v, inRoll || isRoll);
    }
  };
  for (const m of msgs) walk(m.data, false);
  return leaks;
}

async function hello(url: string, name: string, token?: string): Promise<Client> {
  const c = new Client(url);
  await c.open();
  const id = c.send("hello", { name, avatar: "fox", token });
  const r = await c.reply(id);
  assert.equal(r.event, "ack", `hello failed: ${JSON.stringify(r)}`);
  c.token = r.data.token;
  c.publicId = r.data.publicId;
  return c;
}

describe("integration: HTTP and WebSocket server", () => {
  let server: RunningGameServer;
  let url: string;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "tps-int-"));
    server = await startGameServer(0, { store: new MemoryStore(), allowedOrigins: "*", timeScale: 1 });
    url = `ws://127.0.0.1:${server.port}/ws`;
  });

  after(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("health endpoint reports ok and rooms", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; rooms: number };
    assert.equal(body.ok, true);
    assert.equal(typeof body.rooms, "number");
  });

  test("unknown HTTP paths return 404 JSON", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/nope`);
    assert.equal(res.status, 404);
  });

  test("malformed JSON and unknown events return errors, not crashes", async () => {
    const c = await hello(url, "Eve");
    c.sock.send("{not json");
    const bad = await c.wait((m) => m.event === "error");
    assert.equal(bad.data.code, "BAD_JSON");
    const id = c.send("does:not:exist");
    const r = await c.reply(id);
    assert.equal(r.data.code, "UNKNOWN_EVENT");
    c.close();
  });

  test("events before hello are rejected", async () => {
    const c = new Client(url);
    await c.open();
    const id = c.send("room:create");
    const r = await c.reply(id);
    assert.equal(r.data.code, "NOT_AUTHENTICATED");
    c.close();
  });

  test("profile:update changes the display name shown in a room", async () => {
    const c = await hello(url, "Before");
    const r = await c.reply(c.send("profile:update", { name: "After" }));
    assert.equal(r.event, "ack");
    assert.equal(r.data.name, "After");
    const code = (await c.reply(c.send("room:create"))).data.code as string;
    const room = await c.wait((m) => m.event === "room:state" && m.data.code === code);
    assert.equal(room.data.players[0].name, "After");
    c.close();
  });

  test("a hello with a bad name is rejected", async () => {
    const c = new Client(url);
    await c.open();
    const id = c.send("hello", { name: "   ", avatar: "fox" });
    const r = await c.reply(id);
    assert.equal(r.data.code, "INVALID_NAME");
    c.close();
  });

  test("two humans create, join, ready up, select secretly, and a catcher is announced", async () => {
    const host = await hello(url, "Ana");
    const guest = await hello(url, "Ben");

    const created = await host.reply(host.send("room:create"));
    const code = created.data.code as string;
    assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);

    const joined = await guest.reply(guest.send("room:join", { code: code.toLowerCase() }));
    assert.equal(joined.event, "ack");

    await guest.reply(guest.send("room:ready", { ready: true }));
    await host.reply(host.send("room:start"));

    const phase = await host.wait((m) => m.event === "match:phase" && m.data.phase === "dice");
    assert.equal(phase.data.total, 2);

    // Secret selection: the guest must never see the host's number, only a count.
    await host.reply(host.send("match:select", { value: 2 }));
    await guest.reply(guest.send("match:select", { value: 5 }));

    const dice = await host.wait((m) => m.event === "match:dice", 6000);
    assert.ok(dice.data.rolls.length >= 1);
    assert.ok(dice.data.catcherId);
    assert.ok(["Ana", "Ben"].length > 0);
    // Nothing the server sent to the guest exposes selections.
    // The only public `value` fields are rolled faces inside dice_roll events. Any other `value`
    // (such as a selection) would be a leak.
    const leaked = findValueFieldsOutsideRolls(guest.inbox);
    assert.deepEqual(leaked, [], "no selection values sent to other players");

    host.close();
    guest.close();
  });

  test("room capacity: seventh player is rejected with ROOM_FULL", async () => {
    const owner = await hello(url, "Owner");
    const code = (await owner.reply(owner.send("room:create"))).data.code as string;
    const others: Client[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await hello(url, `P${i}`);
      const r = await c.reply(c.send("room:join", { code }));
      assert.equal(r.event, "ack");
      others.push(c);
    }
    const seventh = await hello(url, "Seventh");
    const r = await seventh.reply(seventh.send("room:join", { code }));
    assert.equal(r.event, "error");
    assert.equal(r.data.code, "ROOM_FULL");
    [owner, ...others, seventh].forEach((c) => c.close());
  });

  test("invalid room codes are rejected", async () => {
    const c = await hello(url, "Zed");
    const r = await c.reply(c.send("room:join", { code: "not-a-code" }));
    assert.equal(r.data.code, "INVALID_ROOM_CODE");
    const r2 = await c.reply(c.send("room:join", { code: "ZZZZZ9" }));
    assert.equal(r2.data.code, "ROOM_NOT_FOUND");
    c.close();
  });

  test("non-owner cannot start a match", async () => {
    const host = await hello(url, "H");
    const guest = await hello(url, "G");
    const code = (await host.reply(host.send("room:create"))).data.code as string;
    await guest.reply(guest.send("room:join", { code }));
    await guest.reply(guest.send("room:ready", { ready: true }));
    const r = await guest.reply(guest.send("room:start"));
    assert.equal(r.data.code, "NOT_OWNER");
    host.close();
    guest.close();
  });

  test("a second live session with the same identity is rejected", async () => {
    const first = await hello(url, "Dup");
    const token = first.token!;
    const second = new Client(url);
    await second.open();
    const r = await second.reply(second.send("hello", { name: "Dup", avatar: "fox", token }));
    assert.equal(r.data.code, "DUPLICATE_SESSION");
    first.close();
    second.close();
  });

  test("reconnecting with a token restores the seat after a drop", async () => {
    const host = await hello(url, "Host");
    const code = (await host.reply(host.send("room:create"))).data.code as string;
    const guest = await hello(url, "Gus");
    await guest.reply(guest.send("room:join", { code }));
    const token = guest.token!;
    guest.close();
    await new Promise((r) => setTimeout(r, 150));
    const back = await hello(url, "Gus", token);
    const room = await back.wait((m) => m.event === "room:state" && m.data.code === code);
    const gus = room.data.players.find((p: any) => p.publicId === back.publicId);
    assert.ok(gus, "guest kept seat");
    assert.equal(gus.connected, true);
    host.close();
    back.close();
  });

  test("the reconnect token is never sent to other players", async () => {
    const host = await hello(url, "Tok");
    const guest = await hello(url, "Tok2");
    const code = (await host.reply(host.send("room:create"))).data.code as string;
    await guest.reply(guest.send("room:join", { code }));
    await new Promise((r) => setTimeout(r, 100));
    const seen = JSON.stringify(host.inbox) + JSON.stringify(guest.inbox);
    assert.equal(seen.includes(guest.token!), false, "guest token not in host's messages");
    assert.equal(seen.includes(host.token!), false, "host token not in guest's messages");
    host.close();
    guest.close();
  });

  test("a single-player room runs a full match against bots and reports a winner", async () => {
    // Fast-forward server with TIME_SCALE via a second server instance so the main one stays real-time.
    const fast = await startGameServer(0, { store: new MemoryStore(), allowedOrigins: "*", timeScale: 60 });
    const furl = `ws://127.0.0.1:${fast.port}/ws`;
    try {
      const p = await hello(furl, "Solo");
      const solo = await p.reply(p.send("room:solo", { bots: 2, difficulty: "easy" }));
      assert.equal(solo.event, "ack", JSON.stringify(solo));
      // The human also picks a secret number; the match starts once everyone has chosen.
      await p.reply(p.send("match:select", { value: 3 }));
      const ended = await p.wait((m) => m.event === "match:ended", 60_000);
      assert.ok(["catcher", "survivors"].includes(ended.data.winner));
      assert.equal(ended.data.players.length, 3);
      p.close();
    } finally {
      await fast.close();
    }
  });

  test("a live server rejects rooms of invalid size via solo bot count", async () => {
    const c = await hello(url, "Count");
    const r = await c.reply(c.send("room:solo", { bots: 6, difficulty: "easy" }));
    assert.equal(r.data.code, "INVALID_NUMBER");
    const r2 = await c.reply(c.send("room:solo", { bots: 2, difficulty: "impossible" }));
    assert.equal(r2.data.code, "INVALID_DIFFICULTY");
    c.close();
  });

  test("flooding the socket is rate limited", async () => {
    const c = await hello(url, "Flood");
    let limited = false;
    for (let i = 0; i < 200; i++) c.sock.send(JSON.stringify({ event: "room:leave", reqId: `f${i}` }));
    try {
      await c.wait((m) => m.event === "error" && m.data.code === "RATE_LIMITED", 3000);
      limited = true;
    } catch {
      limited = false;
    }
    assert.equal(limited, true);
    c.close();
  });
});

describe("integration: statistics endpoints", () => {
  test("profile and leaderboard endpoints respond; unknown ids are 404", async () => {
    const store = new MemoryStore();
    const srv = await startGameServer(0, { store, allowedOrigins: "*", timeScale: 1 });
    try {
      const lb = await fetch(`http://127.0.0.1:${srv.port}/api/leaderboard`);
      assert.equal(lb.status, 200);
      assert.deepEqual(await lb.json(), { players: [] });
      const miss = await fetch(`http://127.0.0.1:${srv.port}/api/profile/abcdef0123456789`);
      assert.equal(miss.status, 404);
      const bad = await fetch(`http://127.0.0.1:${srv.port}/api/profile/../../etc`);
      assert.equal(bad.status, 404);
    } finally {
      await srv.close();
    }
  });
});
