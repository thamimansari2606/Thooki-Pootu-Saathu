// Connects server events to the UI state, the snapshot buffer and sound effects.
// Gameplay truth always comes from the server; this module only displays it.
import { GameClient } from "../net/gameClient.ts";
import { SnapshotBuffer, type PlayerPose } from "../game/interpolation.ts";
import type { Effect } from "../game/renderer.ts";
import { getState, setState, toast, errorText, type RoomView, type EndInfo } from "./store.ts";
import { sfx } from "../audio/sfx.ts";
import { WS_URL, HTTP_URL } from "./config.ts";

export const net = new GameClient(WS_URL);
export const snaps = new SnapshotBuffer(40);
export const effects: Effect[] = [];
export const renderClock = { now: () => performance.now() };

let rollTimer: number | null = null;
let lastEventSfx = 0;
let hudTimer: number | null = null;

export function httpUrl(path: string): string {
  return `${HTTP_URL}${path}`;
}

export function startSession(): void {
  net.onState((conn) => setState({ conn }));
  // After a (re)connect the server reattaches us to any room we still hold: show that room.
  net.on("session", (d: { publicId: string; token: string; roomCode?: string | null }) => {
    setState({ publicId: d.publicId });
    if (d.roomCode) setState({ roomCode: d.roomCode, screen: getState().screen === "menu" ? "lobby" : getState().screen });
  });

  net.on("room:state", (room: RoomView) => {
    const s = getState();
    const me = room.players.find((p) => p.publicId === s.publicId);
    setState({ room, roomCode: room.code, localPlayerId: me ? me.publicId : s.localPlayerId });
    if (room.status === "lobby") {
      // Back in the lobby after a match: forget the last pick, and leave the end screen only on purpose.
      setState({ myDice: null });
      if (s.screen !== "ended") setState({ screen: "lobby" });
    }
  });

  net.on("match:phase", (d: { phase: string; total: number; selected: number }) => {
    if (d.phase === "dice") {
      // A new dice phase with nobody selected yet is a fresh match: clear the previous pick.
      const fresh = d.selected === 0;
      setState({
        screen: "dice",
        diceTotal: d.total,
        diceSelected: d.selected,
        rolling: null,
        catcherRevealed: false,
        ...(fresh ? { myDice: null } : {}),
      });
    }
  });

  net.on("match:dice", (d: { rolls: number[]; catcherId: string; events: any[] }) => {
    setState({ rolling: { rolls: d.rolls, catcherId: d.catcherId }, screen: "dice", catcherRevealed: false });
    sfx.diceRoll();
    d.rolls.forEach((_, i) => window.setTimeout(() => sfx.diceTick(), i * 320));
    const total = d.rolls.length * 320 + 400;
    if (rollTimer !== null) clearTimeout(rollTimer);
    window.setTimeout(() => {
      setState({ catcherRevealed: true });
      sfx.catcherAnnounce();
    }, total);
    rollTimer = window.setTimeout(() => {
      setState({ screen: "game", rolling: null });
      sfx.startMusic();
      startHud();
    }, total + 2600);
    handleEvents(d.events);
  });

  net.on("match:snapshot", (d: any) => {
    snaps.push({ at: performance.now(), players: d.players as PlayerPose[], remainingMs: d.remainingMs, phase: d.phase, catcherId: d.catcherId });
    if (d.phase === "playing" && getState().screen === "lobby") setState({ screen: "game" });
  });

  net.on("match:selectProgress", () => undefined);

  net.on("match:events", (d: { events: any[] }) => handleEvents(d.events));

  net.on("match:paused", (d: { paused: boolean }) => {
    setState((s) => ({ hud: { ...s.hud, paused: d.paused } }));
  });

  net.on("match:ended", (d: EndInfo & { matchId: string }) => {
    stopHud();
    sfx.stopMusic();
    const me = getState().publicId;
    const mine = d.players.find((p) => p.publicId === me);
    const won = mine ? (d.winner === "catcher" ? mine.role === "catcher" : mine.role === "survivor" && mine.placement !== null && mine.placement <= d.players.filter((p) => p.role === "survivor").length) : false;
    if (won) sfx.victory();
    else sfx.defeat();
    setState({ screen: "ended", end: d });
  });

  net.on("error", () => undefined);
  net.on("room:left", () => setState({ screen: "menu", room: null, roomCode: null }));
}

function handleEvents(events: any[]) {
  const now = performance.now();
  const s = getState();
  for (const e of events) {
    if (e.type === "damage") {
      effects.push({ kind: "damage", at: now, x: e.x, y: e.y, text: `-${e.amount}`, color: "#ef5350" });
      if (now - lastEventSfx > 60) {
        sfx.hit();
        lastEventSfx = now;
      }
    } else if (e.type === "attack") {
      effects.push({ kind: "swing", at: now, x: snapshotPos(e.by)?.x ?? 0, y: snapshotPos(e.by)?.y ?? 0, dir: snapshotFacing(e.by) });
      sfx.swing();
    } else if (e.type === "knockout") {
      sfx.knockout();
      if (e.id === s.publicId) toast("You were knocked out!");
    } else if (e.type === "dodge") {
      effects.push({ kind: "dodge", at: now, x: snapshotPos(e.id)?.x ?? 0, y: snapshotPos(e.id)?.y ?? 0 });
      sfx.dodge();
    }
  }
}

function snapshotPos(id: string): { x: number; y: number } | null {
  const snap = snaps.latest;
  const p = snap?.players.find((x) => x.id === id);
  return p ? { x: p.x, y: p.y } : null;
}

function snapshotFacing(id: string): { x: number; y: number } | undefined {
  const snap = snaps.latest;
  return snap?.players.find((x) => x.id === id)?.facing;
}

/** Throttled HUD updates (5 Hz) so React re-renders rarely during play. */
function startHud() {
  stopHud();
  hudTimer = window.setInterval(() => {
    const snap = snaps.latest;
    if (!snap) return;
    const me = getState().publicId;
    const mine = snap.players.find((p) => p.id === me);
    const alive = snap.players.filter((p) => !p.knockedOut).length;
    const catcher = snap.players.find((p) => p.role === "catcher");
    const catcherWarning = !!mine && mine.role === "survivor" && !!catcher && Math.hypot(catcher.x - mine.x, catcher.y - mine.y) < 6;
    setState((s) => ({
      hud: {
        remainingMs: snap.remainingMs,
        alive,
        total: snap.players.length,
        hp: mine?.hp ?? 0,
        role: mine?.role ?? null,
        prop: mine?.prop ?? null,
        catcherWarning,
        paused: s.hud.paused,
      },
    }));
  }, 200);
}

function stopHud() {
  if (hudTimer !== null) clearInterval(hudTimer);
  hudTimer = null;
}

export function resetMatchLocal(): void {
  snaps.clear();
  effects.length = 0;
  stopHud();
  sfx.stopMusic();
}

export function requestAction(event: string, data: unknown = {}): Promise<any> {
  return net.request(event, data).catch((e: Error) => {
    toast(errorText(e.message));
    throw e;
  });
}

export { errorText };
