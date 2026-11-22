// Tiny external store for screens and HUD. The 60 Hz game loop never writes here; only
// room events, phase changes and a throttled HUD slice do, so React does not re-render per frame.
import { useSyncExternalStore } from "react";
import type { ConnState } from "../net/gameClient.ts";

export type Screen =
  | "menu"
  | "single"
  | "multi"
  | "lobby"
  | "dice"
  | "game"
  | "ended"
  | "settings"
  | "howto"
  | "stats";

export interface RoomPlayer {
  publicId: string;
  name: string;
  avatar: string;
  ready: boolean;
  connected: boolean;
  isBot: boolean;
}

export interface RoomView {
  code: string;
  status: "lobby" | "in_match" | "closed";
  ownerPublicId: string;
  maxPlayers: number;
  players: RoomPlayer[];
}

export interface Hud {
  remainingMs: number;
  alive: number;
  total: number;
  hp: number;
  role: "catcher" | "survivor" | null;
  prop: string | null;
  catcherWarning: boolean;
  paused: boolean;
}

export interface EndInfo {
  winner: "catcher" | "survivors";
  reason: string;
  players: Array<{ publicId: string; name: string; role: string; placement: number | null; knockouts: number; damageDealt: number; damageTaken: number }>;
}

export interface AppState {
  screen: Screen;
  name: string;
  avatar: string;
  publicId: string | null;
  conn: ConnState;
  roomCode: string | null;
  room: RoomView | null;
  diceTotal: number;
  diceSelected: number;
  myDice: number | null;
  rolling: { rolls: number[]; catcherId: string | null } | null;
  catcherRevealed: boolean;
  hud: Hud;
  end: EndInfo | null;
  toast: string | null;
  solo: { bots: number; difficulty: "easy" | "medium" | "hard" };
  quality: "low" | "medium" | "high";
  zoom: number;
  localPlayerId: string | null;
}

const initial: AppState = {
  screen: "menu",
  name: "",
  avatar: "fox",
  publicId: null,
  conn: "closed",
  roomCode: null,
  room: null,
  diceTotal: 0,
  diceSelected: 0,
  myDice: null,
  rolling: null,
  catcherRevealed: false,
  hud: { remainingMs: 300000, alive: 0, total: 0, hp: 100, role: null, prop: null, catcherWarning: false, paused: false },
  end: null,
  toast: null,
  solo: { bots: 3, difficulty: "medium" },
  quality: "medium",
  zoom: 1,
  localPlayerId: null,
};

let state: AppState = { ...initial, name: localStorage.getItem("tps.name") ?? "", quality: (localStorage.getItem("tps.quality") as AppState["quality"]) ?? "medium" };
const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useAppState<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

export function toast(message: string): void {
  setState({ toast: message });
  window.setTimeout(() => {
    if (getState().toast === message) setState({ toast: null });
  }, 2600);
}

export const ERROR_TEXT: Record<string, string> = {
  ROOM_NOT_FOUND: "No room with that code.",
  ROOM_FULL: "That room is full (6 players).",
  MATCH_IN_PROGRESS: "A match is already running in that room.",
  ALREADY_IN_ROOM: "You are already in a room.",
  NOT_IN_ROOM: "You are not in a room.",
  NOT_OWNER: "Only the room owner can do that.",
  NOT_ENOUGH_PLAYERS: "At least two players are needed to start.",
  NOT_ALL_READY: "Everyone must be ready first.",
  INVALID_NAME: "Please enter a name.",
  INVALID_ROOM_CODE: "Room codes are 6 characters.",
  DUPLICATE_SESSION: "This player is already connected in another window.",
  RATE_LIMITED: "Slow down a little.",
  DISCONNECTED: "Connection lost. Reconnecting...",
  TIMEOUT: "The server did not respond. Try again.",
};

export function errorText(code: string): string {
  return ERROR_TEXT[code] ?? "Something went wrong. Please try again.";
}
