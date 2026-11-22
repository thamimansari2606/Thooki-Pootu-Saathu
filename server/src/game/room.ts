import { randomInt } from "node:crypto";

export const MAX_PLAYERS = 6;
export const MIN_PLAYERS_TO_START = 2;
export const RECONNECT_GRACE_MS = 30_000;
export const ROOM_IDLE_EXPIRY_MS = 10 * 60_000;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const CODE_LENGTH = 6;

export type RoomStatus = "lobby" | "in_match" | "closed";

export interface RoomPlayer {
  playerId: string; // stable identity supplied by the server session
  name: string;
  avatar: string;
  ready: boolean;
  connected: boolean;
  disconnectedAt: number | null;
  isBot: boolean;
}

export interface Room {
  code: string;
  status: RoomStatus;
  ownerId: string;
  players: RoomPlayer[];
  createdAt: number;
  lastActivityAt: number;
}

export type RoomError =
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "MATCH_IN_PROGRESS"
  | "ALREADY_IN_ROOM"
  | "NOT_IN_ROOM"
  | "NOT_OWNER"
  | "NOT_ENOUGH_PLAYERS"
  | "NOT_ALL_READY"
  | "INVALID_NAME";

export class RoomException extends Error {
  readonly code: RoomError;
  constructor(code: RoomError) {
    super(code);
    this.code = code;
  }
}

export interface RoomManagerOptions {
  now?: () => number;
  codeGenerator?: () => string;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private playerToRoom = new Map<string, string>();
  private now: () => number;
  private codeGen: () => string;

  constructor(opts: RoomManagerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.codeGen = opts.codeGenerator ?? defaultCode;
  }

  roomCount(): number {
    return this.rooms.size;
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  roomOf(playerId: string): Room | undefined {
    const code = this.playerToRoom.get(playerId);
    return code ? this.rooms.get(code) : undefined;
  }

  createRoom(host: { playerId: string; name: string; avatar: string }): Room {
    this.assertNotInRoom(host.playerId);
    const name = sanitizeName(host.name);
    let code = this.codeGen();
    while (this.rooms.has(code)) code = this.codeGen();

    const room: Room = {
      code,
      status: "lobby",
      ownerId: host.playerId,
      players: [
        {
          playerId: host.playerId,
          name,
          avatar: host.avatar,
          ready: false,
          connected: true,
          disconnectedAt: null,
          isBot: false,
        },
      ],
      createdAt: this.now(),
      lastActivityAt: this.now(),
    };
    this.rooms.set(code, room);
    this.playerToRoom.set(host.playerId, code);
    return room;
  }

  joinRoom(
    code: string,
    player: { playerId: string; name: string; avatar: string },
  ): Room {
    this.assertNotInRoom(player.playerId);
    const room = this.getRoom(code);
    if (!room || room.status === "closed") throw new RoomException("ROOM_NOT_FOUND");
    if (room.status === "in_match") throw new RoomException("MATCH_IN_PROGRESS");
    if (room.players.length >= MAX_PLAYERS) throw new RoomException("ROOM_FULL");

    room.players.push({
      playerId: player.playerId,
      name: sanitizeName(player.name),
      avatar: player.avatar,
      ready: false,
      connected: true,
      disconnectedAt: null,
      isBot: false,
    });
    this.playerToRoom.set(player.playerId, room.code);
    this.touch(room);
    return room;
  }

  setReady(playerId: string, ready: boolean): Room {
    const room = this.requireRoom(playerId);
    if (room.status !== "lobby") throw new RoomException("MATCH_IN_PROGRESS");
    const p = room.players.find((x) => x.playerId === playerId)!;
    p.ready = ready;
    this.touch(room);
    return room;
  }

  /** Owner-only. Requires >= 2 players and every non-owner human to be ready. */
  startMatch(playerId: string): Room {
    const room = this.requireRoom(playerId);
    if (room.ownerId !== playerId) throw new RoomException("NOT_OWNER");
    if (room.status !== "lobby") throw new RoomException("MATCH_IN_PROGRESS");
    if (room.players.length < MIN_PLAYERS_TO_START)
      throw new RoomException("NOT_ENOUGH_PLAYERS");
    const everyoneReady = room.players.every(
      (p) => p.playerId === room.ownerId || p.ready,
    );
    if (!everyoneReady) throw new RoomException("NOT_ALL_READY");
    room.status = "in_match";
    this.touch(room);
    return room;
  }

  /** Updates a human's display name in their current room (used when they change their name). */
  renamePlayer(playerId: string, name: string): void {
    const room = this.roomOf(playerId);
    if (!room) return;
    const p = room.players.find((x) => x.playerId === playerId);
    if (p && !p.isBot) p.name = sanitizeName(name);
    this.touch(room);
  }

  /** Owner-only. Adds an AI bot (always ready). Used for single-player rooms. */
  addBot(ownerId: string, bot: { playerId: string; name: string; avatar: string }): Room {
    const room = this.requireRoom(ownerId);
    if (room.ownerId !== ownerId) throw new RoomException("NOT_OWNER");
    if (room.status !== "lobby") throw new RoomException("MATCH_IN_PROGRESS");
    if (room.players.length >= MAX_PLAYERS) throw new RoomException("ROOM_FULL");
    room.players.push({
      playerId: bot.playerId,
      name: sanitizeName(bot.name),
      avatar: bot.avatar,
      ready: true,
      connected: true,
      disconnectedAt: null,
      isBot: true,
    });
    this.playerToRoom.set(bot.playerId, room.code);
    this.touch(room);
    return room;
  }

  /** Called by the match layer when a match ends, so the lobby can be reused. */
  endMatch(code: string): Room {
    const room = this.getRoom(code);
    if (!room) throw new RoomException("ROOM_NOT_FOUND");
    room.status = "lobby";
    for (const p of room.players) p.ready = false;
    this.touch(room);
    return room;
  }

  leaveRoom(playerId: string): Room | undefined {
    const room = this.roomOf(playerId);
    if (!room) throw new RoomException("NOT_IN_ROOM");
    this.removePlayer(room, playerId);
    return this.afterRemoval(room);
  }

  markDisconnected(playerId: string): Room | undefined {
    const room = this.roomOf(playerId);
    if (!room) return undefined;
    const p = room.players.find((x) => x.playerId === playerId)!;
    p.connected = false;
    p.ready = false;
    p.disconnectedAt = this.now();
    this.touch(room);
    return room;
  }

  /**
   * Reconnects a player by identity. Only succeeds when the player is still
   * listed in the room and within the grace period. Rejects a second live session.
   */
  reconnect(playerId: string, code: string): Room {
    const room = this.getRoom(code);
    if (!room) throw new RoomException("ROOM_NOT_FOUND");
    const p = room.players.find((x) => x.playerId === playerId);
    if (!p) throw new RoomException("NOT_IN_ROOM");
    if (p.connected) throw new RoomException("ALREADY_IN_ROOM");
    p.connected = true;
    p.disconnectedAt = null;
    this.touch(room);
    return room;
  }

  /** Removes players whose grace period expired and closes idle rooms. Returns closed codes. */
  sweep(): string[] {
    const closed: string[] = [];
    const now = this.now();
    for (const room of [...this.rooms.values()]) {
      for (const p of [...room.players]) {
        if (!p.connected && p.disconnectedAt !== null &&
            now - p.disconnectedAt >= RECONNECT_GRACE_MS) {
          this.removePlayer(room, p.playerId);
        }
      }
      if (room.players.length === 0 ||
          (room.status === "lobby" && now - room.lastActivityAt >= ROOM_IDLE_EXPIRY_MS)) {
        this.closeRoom(room);
        closed.push(room.code);
      } else {
        this.afterRemoval(room);
      }
    }
    return closed;
  }

  /** Creates a room without allocating a code collision; used for private single-player rooms. */
  private requireRoom(playerId: string): Room {
    const room = this.roomOf(playerId);
    if (!room) throw new RoomException("NOT_IN_ROOM");
    return room;
  }

  private assertNotInRoom(playerId: string): void {
    if (this.playerToRoom.has(playerId)) throw new RoomException("ALREADY_IN_ROOM");
  }

  private removePlayer(room: Room, playerId: string): void {
    room.players = room.players.filter((p) => p.playerId !== playerId);
    this.playerToRoom.delete(playerId);
    this.touch(room);
  }

  /** Transfers ownership to the longest-present connected human if the owner left. */
  private afterRemoval(room: Room): Room {
    if (room.players.length === 0) {
      this.closeRoom(room);
      return room;
    }
    if (!room.players.some((p) => p.playerId === room.ownerId)) {
      const next =
        room.players.find((p) => p.connected) ?? room.players[0];
      room.ownerId = next.playerId;
    }
    return room;
  }

  private closeRoom(room: Room): void {
    room.status = "closed";
    this.rooms.delete(room.code);
    for (const p of room.players) this.playerToRoom.delete(p.playerId);
  }

  private touch(room: Room): void {
    room.lastActivityAt = this.now();
  }
}

function defaultCode(): string {
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return s;
}

export function sanitizeName(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 16);
  if (cleaned.length === 0) throw new RoomException("INVALID_NAME");
  return cleaned;
}
