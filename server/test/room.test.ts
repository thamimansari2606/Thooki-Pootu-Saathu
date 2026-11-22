import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  RoomManager,
  RoomException,
  MAX_PLAYERS,
  RECONNECT_GRACE_MS,
  ROOM_IDLE_EXPIRY_MS,
} from "../src/game/room.ts";

function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function p(id: string, name = id) {
  return { playerId: id, name, avatar: "a1" };
}

function expectCode(fn: () => unknown, code: string) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof RoomException, "expected RoomException");
    assert.equal((err as RoomException).code, code);
    return true;
  });
}

function newManager(codes: string[] = ["ROOMAA"]) {
  const clock = makeClock();
  let i = 0;
  const mgr = new RoomManager({
    now: clock.now,
    codeGenerator: () => codes[Math.min(i++, codes.length - 1)],
  });
  return { mgr, clock };
}

describe("room creation and joining", () => {
  test("creating a room makes the creator owner and returns a code", () => {
    const { mgr } = newManager();
    const room = mgr.createRoom(p("host", "Ana"));
    assert.equal(room.code, "ROOMAA");
    assert.equal(room.ownerId, "host");
    assert.equal(room.players.length, 1);
    assert.equal(room.status, "lobby");
  });

  test("join is case-insensitive on the code", () => {
    const { mgr } = newManager();
    mgr.createRoom(p("host"));
    const room = mgr.joinRoom("roomaa", p("guest"));
    assert.equal(room.players.length, 2);
  });

  test("invalid room code is rejected", () => {
    const { mgr } = newManager();
    expectCode(() => mgr.joinRoom("NOPE00", p("guest")), "ROOM_NOT_FOUND");
  });

  test("room holds at most six players; seventh is rejected", () => {
    const { mgr } = newManager();
    mgr.createRoom(p("p0"));
    for (let i = 1; i < MAX_PLAYERS; i++) mgr.joinRoom("ROOMAA", p(`p${i}`));
    assert.equal(mgr.getRoom("ROOMAA")!.players.length, MAX_PLAYERS);
    expectCode(() => mgr.joinRoom("ROOMAA", p("p6")), "ROOM_FULL");
  });

  test("a player cannot be in two rooms at once", () => {
    const { mgr } = newManager(["ROOMAA", "ROOMBB"]);
    mgr.createRoom(p("host"));
    expectCode(() => mgr.createRoom(p("host")), "ALREADY_IN_ROOM");
    mgr.createRoom(p("other"));
    expectCode(() => mgr.joinRoom("ROOMBB", p("host")), "ALREADY_IN_ROOM");
  });

  test("blank or control-character names are rejected", () => {
    const { mgr } = newManager();
    expectCode(() => mgr.createRoom(p("host", "   ")), "INVALID_NAME");
    expectCode(() => mgr.createRoom(p("host", "\u0001\u0002")), "INVALID_NAME");
  });

  test("joining during a match is rejected", () => {
    const { mgr } = newManager();
    mgr.createRoom(p("host"));
    mgr.joinRoom("ROOMAA", p("guest"));
    mgr.setReady("guest", true);
    mgr.startMatch("host");
    expectCode(() => mgr.joinRoom("ROOMAA", p("late")), "MATCH_IN_PROGRESS");
  });
});

describe("ready state and owner start", () => {
  test("ready/unready toggles a player's status", () => {
    const { mgr } = newManager();
    mgr.createRoom(p("host"));
    mgr.joinRoom("ROOMAA", p("guest"));
    mgr.setReady("guest", true);
    assert.equal(mgr.getRoom("ROOMAA")!.players[1].ready, true);
    mgr.setReady("guest", false);
    assert.equal(mgr.getRoom("ROOMAA")!.players[1].ready, false);
  });

  test("only the owner can start", () => {
    const { mgr } = newManager();
    mgr.createRoom(p("host"));
    mgr.joinRoom("ROOMAA", p("guest"));
    mgr.setReady("guest", true);
    expectCode(() => mgr.startMatch("guest"), "NOT_OWNER");
  });

  test("start needs at least two players", () => {
    const { mgr } = newManager();
    mgr.createRoom(p("host"));
    expectCode(() => mgr.startMatch("host"), "NOT_ENOUGH_PLAYERS");
  });

  test("start needs every non-owner ready", () => {
    const { mgr } = newManager();
    mgr.createRoom(p("host"));
    mgr.joinRoom("ROOMAA", p("g1"));
    mgr.joinRoom("ROOMAA", p("g2"));
    mgr.setReady("g1", true);
    expectCode(() => mgr.startMatch("host"), "NOT_ALL_READY");
    mgr.setReady("g2", true);
    assert.equal(mgr.startMatch("host").status, "in_match");
  });

  test("ready changes are blocked during a match", () => {
    const { mgr } = newManager();
    mgr.createRoom(p("host"));
    mgr.joinRoom("ROOMAA", p("guest"));
    mgr.setReady("guest", true);
    mgr.startMatch("host");
    expectCode(() => mgr.setReady("guest", false), "MATCH_IN_PROGRESS");
  });

  test("endMatch returns the room to the lobby and clears ready flags", () => {
    const { mgr } = newManager();
    mgr.createRoom(p("host"));
    mgr.joinRoom("ROOMAA", p("guest"));
    mgr.setReady("guest", true);
    mgr.startMatch("host");
    mgr.endMatch("ROOMAA");
    const room = mgr.getRoom("ROOMAA")!;
    assert.equal(room.status, "lobby");
    assert.equal(room.players[1].ready, false);
  });
});

describe("leaving, ownership transfer and disconnection", () => {
  test("owner leaving transfers ownership to a remaining player", () => {
    const { mgr } = newManager();
    mgr.createRoom(p("host"));
    mgr.joinRoom("ROOMAA", p("guest"));
    const room = mgr.leaveRoom("host")!;
    assert.equal(room.ownerId, "guest");
    assert.equal(mgr.roomOf("host"), undefined);
  });

  test("the last player leaving closes the room", () => {
    const { mgr } = newManager();
    mgr.createRoom(p("host"));
    mgr.leaveRoom("host");
    assert.equal(mgr.getRoom("ROOMAA"), undefined);
  });

  test("a disconnected player keeps their seat during the grace period", () => {
    const { mgr, clock } = newManager();
    mgr.createRoom(p("host"));
    mgr.joinRoom("ROOMAA", p("guest"));
    mgr.markDisconnected("guest");
    clock.advance(RECONNECT_GRACE_MS - 1);
    mgr.sweep();
    assert.equal(mgr.getRoom("ROOMAA")!.players.length, 2);
  });

  test("a disconnected player is removed after the grace period", () => {
    const { mgr, clock } = newManager();
    mgr.createRoom(p("host"));
    mgr.joinRoom("ROOMAA", p("guest"));
    mgr.markDisconnected("guest");
    clock.advance(RECONNECT_GRACE_MS);
    mgr.sweep();
    assert.equal(mgr.getRoom("ROOMAA")!.players.length, 1);
    assert.equal(mgr.roomOf("guest"), undefined);
  });

  test("reconnect restores the seat and clears the timer", () => {
    const { mgr, clock } = newManager();
    mgr.createRoom(p("host"));
    mgr.joinRoom("ROOMAA", p("guest"));
    mgr.markDisconnected("guest");
    clock.advance(5_000);
    mgr.reconnect("guest", "ROOMAA");
    clock.advance(RECONNECT_GRACE_MS);
    mgr.sweep();
    const room = mgr.getRoom("ROOMAA")!;
    assert.equal(room.players.length, 2);
    assert.equal(room.players[1].connected, true);
  });

  test("reconnect is rejected for a player who is still connected (duplicate session)", () => {
    const { mgr } = newManager();
    mgr.createRoom(p("host"));
    expectCode(() => mgr.reconnect("host", "ROOMAA"), "ALREADY_IN_ROOM");
  });

  test("reconnect is rejected for a player removed after the grace period", () => {
    const { mgr, clock } = newManager();
    mgr.createRoom(p("host"));
    mgr.joinRoom("ROOMAA", p("guest"));
    mgr.markDisconnected("guest");
    clock.advance(RECONNECT_GRACE_MS);
    mgr.sweep();
    expectCode(() => mgr.reconnect("guest", "ROOMAA"), "NOT_IN_ROOM");
  });

  test("a disconnected owner transfers ownership on removal", () => {
    const { mgr, clock } = newManager();
    mgr.createRoom(p("host"));
    mgr.joinRoom("ROOMAA", p("guest"));
    mgr.markDisconnected("host");
    clock.advance(RECONNECT_GRACE_MS);
    mgr.sweep();
    assert.equal(mgr.getRoom("ROOMAA")!.ownerId, "guest");
  });

  test("disconnect clears the ready flag so a rejoin must re-confirm", () => {
    const { mgr } = newManager();
    mgr.createRoom(p("host"));
    mgr.joinRoom("ROOMAA", p("guest"));
    mgr.setReady("guest", true);
    mgr.markDisconnected("guest");
    mgr.reconnect("guest", "ROOMAA");
    assert.equal(mgr.getRoom("ROOMAA")!.players[1].ready, false);
  });
});

describe("room expiration", () => {
  test("an idle lobby expires", () => {
    const { mgr, clock } = newManager();
    mgr.createRoom(p("host"));
    clock.advance(ROOM_IDLE_EXPIRY_MS);
    const closed = mgr.sweep();
    assert.deepEqual(closed, ["ROOMAA"]);
    expectCode(() => mgr.joinRoom("ROOMAA", p("guest")), "ROOM_NOT_FOUND");
  });

  test("an active lobby does not expire", () => {
    const { mgr, clock } = newManager();
    mgr.createRoom(p("host"));
    clock.advance(ROOM_IDLE_EXPIRY_MS - 1000);
    mgr.setReady("host", false);
    clock.advance(ROOM_IDLE_EXPIRY_MS - 1000);
    assert.deepEqual(mgr.sweep(), []);
  });
});

describe("single-player bot seats", () => {
  test("owner can add up to five bots, which are always ready", () => {
    const { mgr } = newManager();
    mgr.createRoom(p("host"));
    for (let i = 0; i < 5; i++) mgr.addBot("host", { playerId: `bot${i}`, name: `Bot ${i}`, avatar: "bot" });
    const room = mgr.getRoom("ROOMAA")!;
    assert.equal(room.players.length, 6);
    assert.ok(room.players.filter((x) => x.isBot).every((x) => x.ready));
    expectCode(() => mgr.addBot("host", { playerId: "bot5", name: "x", avatar: "bot" }), "ROOM_FULL");
  });

  test("a non-owner cannot add bots", () => {
    const { mgr } = newManager();
    mgr.createRoom(p("host"));
    mgr.joinRoom("ROOMAA", p("guest"));
    expectCode(() => mgr.addBot("guest", { playerId: "bot", name: "x", avatar: "bot" }), "NOT_OWNER");
  });

  test("a human plus one bot can start", () => {
    const { mgr } = newManager();
    mgr.createRoom(p("host"));
    mgr.addBot("host", { playerId: "bot", name: "Bot", avatar: "bot" });
    assert.equal(mgr.startMatch("host").status, "in_match");
  });
});
