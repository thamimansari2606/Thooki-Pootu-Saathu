// Multiplayer and single-player server. Socket.IO-style named events over a `ws` WebSocket at /ws.
// Every gameplay outcome is decided here. Clients only send intents (move, select, attack).
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { Match, MatchError, PROP_IDS, type Phase, type PropId, type MatchEvent } from "../game/match.ts";
import { RoomManager, RoomException, MAX_PLAYERS, RECONNECT_GRACE_MS, type Room } from "../game/room.ts";
import { Bot, perceive, PERSONALITIES, type Difficulty, type Personality } from "../ai/bot.ts";
import {
  asAvatar,
  asAxis,
  asBool,
  asDifficulty,
  asInt,
  asName,
  asRoomCode,
  asToken,
  MAX_MESSAGE_BYTES,
  RateLimiter,
  ValidationError,
} from "./validate.ts";
import type { Store, MatchResult } from "../store/store.ts";

const TICK_MS = 50;
const SNAPSHOT_EVERY_TICKS = 2;
const BOT_NAMES = ["Pip", "Mochi", "Dodo", "Nori", "Kiko"];

export interface GameServerOptions {
  store: Store;
  allowedOrigins?: string[] | "*";
  timeScale?: number; // simulation sub-steps per tick; tests use >1 to fast-forward
  now?: () => number;
  randomBytesFn?: (n: number) => Buffer;
}

interface Session {
  token: string;
  publicId: string;
  name: string;
  avatar: string;
  socket: WebSocket | null;
}

interface ActiveMatch {
  code: string;
  matchId: string;
  match: Match;
  bots: Map<string, Bot>;
  startedAt: number;
  ticks: number;
  timers: NodeJS.Timeout[];
  interval: NodeJS.Timeout | null;
  disconnectedAt: Map<string, number>;
  done: boolean;
}

export interface RunningGameServer {
  httpServer: HttpServer;
  port: number;
  close(): Promise<void>;
  stats(): { rooms: number; activeMatches: number; sessions: number; uptimeSec: number };
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Stable public identity derived from the secret token. Safe to show other players. */
export function publicIdOf(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function startGameServer(port: number, opts: GameServerOptions): Promise<RunningGameServer> {
  const now = opts.now ?? Date.now;
  const timeScale = Math.max(1, Math.floor(opts.timeScale ?? 1));
  const newToken = () => (opts.randomBytesFn ?? randomBytes)(16).toString("hex");
  const rooms = new RoomManager({ now });
  const sessions = new Map<string, Session>();
  const activeByCode = new Map<string, ActiveMatch>();
  const startedAt = now();

  const allowed = opts.allowedOrigins ?? [];
  const originAllowed = (origin: string | undefined) => {
    if (allowed === "*") return true;
    if (!origin) return false;
    return allowed.includes(origin);
  };

  // ---------- HTTP ----------
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (origin && originAllowed(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url?.startsWith("/api/profile/") && req.method === "GET") {
      const id = decodeURIComponent(req.url.slice("/api/profile/".length));
      const lookup = /^[a-f0-9]{16}$/.test(id) ? opts.store.getProfile(id) : Promise.resolve(null);
      lookup
        .then((profile) => {
          res.writeHead(profile ? 200 : 404, { "Content-Type": "application/json" });
          res.end(JSON.stringify(profile ?? { error: "NOT_FOUND" }));
        })
        .catch(() => sendJson(res, 500, { error: "STORE_UNAVAILABLE" }));
      return;
    }
    if (req.url === "/api/leaderboard" && req.method === "GET") {
      opts.store
        .topProfiles(10)
        .then((players) => sendJson(res, 200, { players }))
        .catch(() => sendJson(res, 500, { error: "STORE_UNAVAILABLE" }));
      return;
    }
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, rooms: rooms.roomCount(), uptimeSec: Math.round((now() - startedAt) / 1000) }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "NOT_FOUND" }));
  });

  // ---------- WebSocket ----------
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    maxPayload: MAX_MESSAGE_BYTES,
    verifyClient: (info, done) => done(originAllowed(info.origin), 403, "Origin not allowed"),
  });

  type Socket = WebSocket & { session?: Session; sockLimiter?: RateLimiter };

  function send(sock: WebSocket, event: string, data: unknown, reqId?: string) {
    if (sock.readyState !== WebSocket.OPEN) return;
    sock.send(JSON.stringify({ event, data, reqId }));
  }

  function sendError(sock: WebSocket, code: string, reqId?: string) {
    send(sock, "error", { code }, reqId);
  }

  function sessionSocket(s: Session): WebSocket | null {
    return s.socket && s.socket.readyState === WebSocket.OPEN ? s.socket : null;
  }

  function roomPublic(room: Room) {
    return {
      code: room.code,
      status: room.status,
      ownerPublicId: publicOf(room.ownerId),
      maxPlayers: MAX_PLAYERS,
      players: room.players.map((p) => ({
        publicId: publicOf(p.playerId),
        name: p.name,
        avatar: p.avatar,
        ready: p.ready,
        connected: p.connected,
        isBot: p.isBot,
      })),
    };
  }

  function publicOf(playerId: string): string {
    return playerId.startsWith("bot-") ? playerId : publicIdOf(playerId);
  }

  function broadcastRoom(code: string) {
    const room = rooms.getRoom(code);
    if (!room) return;
    const payload = roomPublic(room);
    for (const p of room.players) {
      const s = sessions.get(p.playerId);
      const sock = s && sessionSocket(s);
      if (sock) send(sock, "room:state", payload);
    }
  }

  function broadcastToRoom(code: string, event: string, data: unknown) {
    const room = rooms.getRoom(code);
    if (!room) return;
    for (const p of room.players) {
      const s = sessions.get(p.playerId);
      const sock = s && sessionSocket(s);
      if (sock) send(sock, event, data);
    }
  }

  /** Maps internal player ids to public ids inside match data before it leaves the server. */
  function mapEvent(e: MatchEvent): unknown {
    const out: Record<string, unknown> = { ...e };
    for (const key of ["id", "by", "target"]) {
      const v = out[key];
      if (typeof v === "string") out[key] = publicOf(v);
    }
    return out;
  }

  function mapSnapshot(snap: ReturnType<Match["snapshot"]>) {
    return {
      ...snap,
      catcherId: snap.catcherId ? publicOf(snap.catcherId) : null,
      players: snap.players.map((p) => ({ ...p, id: publicOf(p.id) })),
    };
  }

  // ---------- Match lifecycle ----------
  function startMatchForRoom(room: Room) {
    const specs = room.players.map((p) => ({ id: p.playerId, name: p.name, isBot: p.isBot }));
    const match = new Match(specs, Math.random);
    const bots = new Map<string, Bot>();
    const difficulty = botDifficulty.get(room.code) ?? "medium";
    const personalities = botPersonalities.get(room.code) ?? [];
    let personalityIdx = 0;
    for (const p of room.players) {
      if (!p.isBot) continue;
      const personality: Personality = personalities[personalityIdx++] ?? PERSONALITIES[personalityIdx % PERSONALITIES.length];
      bots.set(p.playerId, new Bot({ id: p.playerId, name: p.name, personality, difficulty }));
    }
    const am: ActiveMatch = {
      code: room.code,
      matchId: randomUUID(),
      match,
      bots,
      startedAt: now(),
      ticks: 0,
      timers: [],
      interval: null,
      disconnectedAt: new Map(),
      done: false,
    };
    activeByCode.set(room.code, am);
    broadcastToRoom(room.code, "match:phase", { phase: "dice", total: match.fighters.size, selected: 0 });
    broadcastRoom(room.code);

    // Bots pick their secret number after a human-like delay. They choose uniformly at random:
    // they never see anyone else's selection.
    for (const bot of bots.values()) {
      const delay = 300 + Math.random() * 1200;
      const t = setTimeout(() => {
        if (am.done || match.phase !== "dice" || match.hasSelected(bot.id)) return;
        const value = Math.floor(Math.random() * 6) + 1;
        match.selectNumber(bot.id, value);
        afterSelection(am);
      }, delay);
      am.timers.push(t);
    }

    am.interval = setInterval(() => tickMatch(am), TICK_MS);
    am.interval.unref?.();
  }

  function afterSelection(am: ActiveMatch) {
    broadcastToRoom(am.code, "match:phase", {
      phase: "dice",
      total: am.match.fighters.size,
      selected: am.match.selectedCount(),
    });
    if (am.match.allSelected() && am.match.phase === "dice") {
      const catcherId = am.match.resolveDice();
      const events = am.match.drainEvents();
      broadcastToRoom(am.code, "match:dice", {
        rolls: am.match.rolls,
        catcherId: publicOf(catcherId),
        events: events.map(mapEvent),
      });
    }
  }

  // Reads the phase without TypeScript narrowing it across the tick (phase changes inside step()).
  const phaseOf = (m: Match): Phase => m.phase;

  function tickMatch(am: ActiveMatch) {
    if (am.done) return;
    const match = am.match;
    if (phaseOf(match) !== "playing") {
      if (phaseOf(match) === "ended") finishMatch(am);
      return;
    }
    am.ticks++;

    // Forfeit humans who never reconnected within the grace period.
    for (const [id, t] of am.disconnectedAt) {
      if (now() - t >= RECONNECT_GRACE_MS) {
        match.forfeit(id);
        am.disconnectedAt.delete(id);
      }
    }

    for (let k = 0; k < timeScale; k++) {
      const all = [...match.fighters.values()].map((f) => ({
        id: f.id,
        x: f.pos.x,
        y: f.pos.y,
        role: f.role,
        knockedOut: f.knockedOut,
      }));
      for (const bot of am.bots.values()) {
        const f = match.fighters.get(bot.id);
        if (!f || f.knockedOut) continue;
        const view = perceive(
          { id: f.id, x: f.pos.x, y: f.pos.y, role: f.role, hp: f.hp, prop: f.prop, knockedOut: f.knockedOut },
          all,
          bot.perceptionRange,
          match.matchTimeMs,
        );
        match.setInput(bot.id, bot.think(view, TICK_MS));
      }
      match.step(TICK_MS);
      if (phaseOf(match) !== "playing") break;
    }

    const events = match.drainEvents();
    if (events.length > 0) broadcastToRoom(am.code, "match:events", { events: events.map(mapEvent) });
    if (am.ticks % SNAPSHOT_EVERY_TICKS === 0 || phaseOf(match) === "ended") {
      broadcastToRoom(am.code, "match:snapshot", mapSnapshot(match.snapshot(null)));
    }
    if (phaseOf(match) === "ended") finishMatch(am);
  }

  function finishMatch(am: ActiveMatch) {
    if (am.done) return;
    am.done = true;
    if (am.interval) clearInterval(am.interval);
    for (const t of am.timers) clearTimeout(t);
    activeByCode.delete(am.code);

    const match = am.match;
    const winner = match.winner ?? "survivors";
    const reason = match.endReason ?? "timeout";
    const players = [...match.fighters.values()].filter((f) => !f.isBot);
    const humanOnly = players.filter((f) => !am.bots.has(f.id));
    const result: MatchResult = {
      matchId: am.matchId,
      endedAt: new Date(now()).toISOString(),
      winner,
      reason,
      durationMs: Math.round(match.matchTimeMs),
      players: humanOnly.map((f) => ({
        playerId: publicOf(f.id),
        name: f.name,
        role: f.role,
        knockouts: f.stats.knockouts,
        damageDealt: f.stats.damageDealt,
        damageTaken: f.stats.damageTaken,
        survivedMs: f.stats.survivedMs,
        placement: f.placement,
        won: winner === "catcher" ? f.role === "catcher" : f.role === "survivor" && !f.knockedOut,
      })),
    };
    // Persistence failure must not break the live game; it is logged, not thrown.
    opts.store.recordMatch(result).catch((err: unknown) => {
      console.error("failed to record match", am.matchId, err instanceof Error ? err.message : err);
    });

    broadcastToRoom(am.code, "match:ended", {
      winner,
      reason,
      matchId: am.matchId,
      players: [...match.fighters.values()].map((f) => ({
        publicId: publicOf(f.id),
        name: f.name,
        role: f.role,
        placement: f.placement,
        knockouts: f.stats.knockouts,
        damageDealt: f.stats.damageDealt,
        damageTaken: f.stats.damageTaken,
      })),
    });
    rooms.endMatch(am.code);
    broadcastRoom(am.code);
  }

  function stopMatchForRoom(code: string) {
    const am = activeByCode.get(code);
    if (!am) return;
    am.done = true;
    if (am.interval) clearInterval(am.interval);
    for (const t of am.timers) clearTimeout(t);
    activeByCode.delete(code);
  }

  // Botdifficulty / personalities are chosen when the single-player room is created.
  const botDifficulty = new Map<string, Difficulty>();
  const botPersonalities = new Map<string, Personality[]>();

  // ---------- Sweep ----------
  const sweepTimer = setInterval(() => {
    const closed = rooms.sweep();
    for (const code of closed) stopMatchForRoom(code);
  }, 1000);
  sweepTimer.unref?.();

  // ---------- Message handling ----------
  wss.on("connection", (sock: Socket) => {
    sock.sockLimiter = new RateLimiter(60, 30, now());

    sock.on("message", (raw: RawData) => {
      let msg: { event?: unknown; data?: unknown; reqId?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        sendError(sock, "BAD_JSON");
        return;
      }
      if (!msg || typeof msg !== "object" || typeof msg.event !== "string") {
        sendError(sock, "BAD_MESSAGE");
        return;
      }
      const reqId = typeof msg.reqId === "string" && msg.reqId.length <= 64 ? msg.reqId : undefined;

      if (!sock.sockLimiter!.take(now())) {
        sendError(sock, "RATE_LIMITED", reqId);
        return;
      }

      try {
        const payload = handle(sock, msg.event, msg.data, reqId);
        if (reqId !== undefined) send(sock, "ack", payload ?? { ok: true }, reqId);
      } catch (e) {
        if (e instanceof ValidationError || e instanceof RoomException || e instanceof MatchError) {
          sendError(sock, e.code, reqId);
        } else {
          sendError(sock, "INTERNAL", reqId);
        }
      }
    });

    sock.on("close", () => {
      const s = sock.session;
      if (!s || s.socket !== sock) return;
      s.socket = null;
      const room = rooms.roomOf(s.token);
      if (!room) return;
      rooms.markDisconnected(s.token);
      const am = activeByCode.get(room.code);
      if (am) am.disconnectedAt.set(s.token, now());
      broadcastRoom(room.code);
    });
  });

  function requireSession(sock: Socket): Session {
    const s = sock.session;
    if (!s) throw new ValidationError("NOT_AUTHENTICATED");
    return s;
  }

  /** Routes one event. Returns the ack payload; the caller sends it (exactly once). */
  function handle(sock: Socket, event: string, data: unknown, reqId?: string): unknown {
    const d = (data ?? {}) as Record<string, unknown>;

    if (event === "hello") {
      if (sock.session) throw new ValidationError("ALREADY_HELLO");
      const requested = asToken(d.token);
      const name = asName(d.name);
      const avatar = asAvatar(d.avatar);
      let token = requested ?? newToken();
      let s = sessions.get(token);
      if (s) {
        const live = sessionSocket(s);
        if (live && live !== sock) throw new ValidationError("DUPLICATE_SESSION");
      } else {
        s = { token, publicId: publicIdOf(token), name, avatar, socket: null };
        sessions.set(token, s);
      }
      s.name = name;
      s.avatar = avatar;
      s.socket = sock;
      sock.session = s;
      token = s.token;

      // Reconnect into an existing room if still listed (within grace).
      const room = rooms.roomOf(token);
      const ack = { token, publicId: s.publicId, name, avatar, roomCode: room?.code ?? null };
      if (room) {
        const p = room.players.find((x) => x.playerId === token);
        if (p && !p.connected) rooms.reconnect(token, room.code);
        const am = activeByCode.get(room.code);
        if (am) am.disconnectedAt.delete(token);
        broadcastRoom(room.code);
        const am2 = activeByCode.get(room.code);
        if (am2) send(sock, "match:snapshot", mapSnapshot(am2.match.snapshot(null)));
      }
      return ack;
    }

    // Per-socket rate limiting already ran in the message handler.
    const s = requireSession(sock);

    switch (event) {
      case "profile:update": {
        const name = d.name === undefined ? s.name : asName(d.name);
        const avatar = d.avatar === undefined ? s.avatar : asAvatar(d.avatar);
        s.name = name;
        s.avatar = avatar;
        const room = rooms.roomOf(s.token);
        if (room) {
          rooms.renamePlayer(s.token, name);
          broadcastRoom(room.code);
        }
        return { name, avatar };
      }
      case "room:create": {
        const room = rooms.createRoom({ playerId: s.token, name: s.name, avatar: s.avatar });
        broadcastRoom(room.code);
        return { code: room.code };
      }
      case "room:join": {
        const code = asRoomCode(d.code);
        const room = rooms.joinRoom(code, { playerId: s.token, name: s.name, avatar: s.avatar });
        broadcastRoom(room.code);
        return { code: room.code };
      }
      case "room:solo": {
        const bots = asInt(d.bots, 1, 5);
        const difficulty = asDifficulty(d.difficulty);
        const room = rooms.createRoom({ playerId: s.token, name: s.name, avatar: s.avatar });
        botDifficulty.set(room.code, difficulty);
        const shuffled = [...PERSONALITIES].sort(() => Math.random() - 0.5);
        botPersonalities.set(room.code, shuffled.slice(0, bots));
        for (let i = 0; i < bots; i++) {
          const botId = `bot-${room.code}-${i}`;
          rooms.addBot(s.token, { playerId: botId, name: BOT_NAMES[i % BOT_NAMES.length], avatar: asAvatar(undefined) });
        }
        rooms.startMatch(s.token);
        startMatchForRoom(rooms.getRoom(room.code)!);
        return { code: room.code };
      }
      case "room:ready": {
        rooms.setReady(s.token, asBool(d.ready));
        broadcastRoom(rooms.roomOf(s.token)!.code);
        return undefined;
      }
      case "room:start": {
        const room = rooms.startMatch(s.token);
        startMatchForRoom(room);
        return { code: room.code };
      }
      case "room:leave": {
        const room = rooms.roomOf(s.token);
        if (!room) throw new RoomException("NOT_IN_ROOM");
        const code = room.code;
        const am = activeByCode.get(code);
        if (am) am.match.forfeit(s.token);
        rooms.leaveRoom(s.token);
        if (!rooms.getRoom(code)) stopMatchForRoom(code);
        send(sock, "room:left", {});
        broadcastRoom(code);
        return undefined;
      }
      case "room:pause": {
        const room = rooms.roomOf(s.token);
        if (!room || room.ownerId !== s.token) throw new RoomException("NOT_OWNER");
        const am = activeByCode.get(room.code);
        if (!am) throw new MatchError("NO_ACTIVE_MATCH");
        am.match.setPaused(asBool(d.paused));
        broadcastToRoom(room.code, "match:paused", { paused: am.match.paused });
        return undefined;
      }
      case "match:select": {
        const room = rooms.roomOf(s.token);
        const am = room && activeByCode.get(room.code);
        if (!am) throw new MatchError("NO_ACTIVE_MATCH");
        const value = asInt(d.value, 1, 6);
        am.match.selectNumber(s.token, value);
        afterSelection(am);
        return { ok: true };
      }
      case "match:input": {
        const room = rooms.roomOf(s.token);
        const am = room && activeByCode.get(room.code);
        if (!am) return undefined;
        const prop = typeof d.prop === "string" && (PROP_IDS as string[]).includes(d.prop) ? (d.prop as PropId) : undefined;
        am.match.setInput(s.token, {
          dx: asAxis(d.dx),
          dy: asAxis(d.dy),
          sprint: d.sprint === true,
          dodge: d.dodge === true,
          attack: d.attack === true,
          prop,
        });
        return undefined;
      }
      case "match:prop": {
        const room = rooms.roomOf(s.token);
        const am = room && activeByCode.get(room.code);
        if (!am) throw new MatchError("NO_ACTIVE_MATCH");
        am.match.switchProp(s.token, d.prop);
        return undefined;
      }
      default:
        throw new ValidationError("UNKNOWN_EVENT");
    }
  }

  // ---------- Listen ----------
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, () => {
      const addr = httpServer.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        httpServer,
        port: actualPort,
        stats: () => ({
          rooms: rooms.roomCount(),
          activeMatches: activeByCode.size,
          sessions: sessions.size,
          uptimeSec: Math.round((now() - startedAt) / 1000),
        }),
        close: () =>
          new Promise<void>((res) => {
            clearInterval(sweepTimer);
            for (const am of activeByCode.values()) stopMatchForRoom(am.code);
            for (const client of wss.clients) client.terminate();
            wss.close(() => httpServer.close(() => res()));
          }),
      });
    });
  });
}
