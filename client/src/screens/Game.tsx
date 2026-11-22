import { useEffect, useRef, useState } from "react";
import { ArenaRenderer, type Quality } from "../game/renderer.ts";
import { InputController } from "../game/input.ts";
import { useAppState, setState, getState } from "../app/store.ts";
import { net, snaps, effects, renderClock, requestAction } from "../app/session.ts";
import { Button } from "./common.tsx";
import { PROP_IDS_ORDER } from "./propOrder.ts";
import type { Intent } from "../game/controls.ts";
import type { Vec2 } from "../game/iso.ts";

function fmt(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function Game() {
  const hud = useAppState((s) => s.hud);
  const quality = useAppState((s) => s.quality);
  const zoom = useAppState((s) => s.zoom);
  const room = useAppState((s) => s.room);
  const publicId = useAppState((s) => s.publicId);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stickRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const [inputApi, setInputApi] = useState<InputController | null>(null);
  const isOwner = room?.ownerPublicId === publicId;

  // Render loop: pure drawing from buffered snapshots, no React state changes per frame.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const renderer = new ArenaRenderer(canvas);
    renderer.setQuality(quality as Quality);
    renderer.setZoom(zoom);
    const onResize = () => renderer.resize();
    window.addEventListener("resize", onResize);
    let raf = 0;
    const loop = () => {
      const now = renderClock.now();
      const poses = snaps.sample(now);
      const s = getState();
      if (poses) {
        const me = poses.find((p) => p.id === s.publicId);
        const catcher = poses.find((p) => p.role === "catcher");
        const cam = me ?? catcher ?? poses[0];
        const alive = effects.filter((e) => now - e.at < 1000);
        effects.length = 0;
        effects.push(...alive);
        renderer.draw({ poses, camera: { x: cam.x, y: cam.y }, localId: s.publicId, catcherId: catcher?.id ?? null, effects, now });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [quality, zoom]);

  // Keyboard, joystick and buttons send intents at 20 Hz.
  useEffect(() => {
    const input = new InputController({
      onIntent: (intent: Intent) => {
        if (getState().hud.paused) return;
        net.fire("match:input", intent);
      },
      onProp: (slot) => {
        const prop = PROP_IDS_ORDER[slot];
        net.fire("match:prop", { prop });
      },
      onPause: () => togglePause(),
    });
    input.start();
    setInputApi(input);
    return () => input.stop();
  }, []);

  const togglePause = () => {
    if (!isOwnerNow()) {
      setState((s) => ({ hud: { ...s.hud, paused: !s.hud.paused } }));
      return;
    }
    const next = !getState().hud.paused;
    setState((s) => ({ hud: { ...s.hud, paused: next } }));
    requestAction("room:pause", { paused: next }).catch(() => undefined);
  };
  const isOwnerNow = () => {
    const r = getState().room;
    return !!r && r.ownerPublicId === getState().publicId;
  };

  // Virtual joystick on touch devices and a mouse-drag stick on desktop.
  const stickVec = useRef<Vec2 | null>(null);
  const onStickMove = (clientX: number, clientY: number) => {
    const el = stickRef.current!;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = (clientX - cx) / (r.width / 2);
    const dy = (clientY - cy) / (r.height / 2);
    const v = { x: Math.max(-1, Math.min(1, dx)), y: Math.max(-1, Math.min(1, dy)) };
    stickVec.current = v;
    inputApi?.setStick(v);
    if (knobRef.current) knobRef.current.style.transform = `translate(${v.x * 34}px, ${v.y * 34}px)`;
  };
  const onStickEnd = () => {
    stickVec.current = null;
    inputApi?.setStick(null);
    if (knobRef.current) knobRef.current.style.transform = "translate(0,0)";
  };

  const press = (action: "attack" | "dodge" | "sprint", down: boolean) => inputApi?.press(action, down);

  return (
    <div className="game">
      <canvas ref={canvasRef} className="arena" aria-label="Game arena" />

      <header className="hud-top">
        <div className="hud-chip timer" aria-label="Time remaining">⏱ {fmt(hud.remainingMs)}</div>
        <div className="hud-chip" aria-label="Players remaining">Alive {hud.alive}/{hud.total}</div>
        <div className={`hud-chip role ${hud.role === "catcher" ? "catcher" : ""}`}>
          {hud.role === "catcher" ? "CATCHER" : hud.role === "survivor" ? "Survivor" : "—"}
        </div>
        {hud.role === "catcher" && <div className="hud-chip prop">Prop: {hud.prop ?? "—"}</div>}
        <div className="hp">
          <div className="hp-fill" style={{ width: `${hud.hp}%` }} />
          <span>{hud.hp} HP</span>
        </div>
      </header>

      {hud.catcherWarning && <div className="warning">⚠ Catcher close!</div>}

      <button className="menu-btn" onClick={togglePause} aria-label="Pause">❚❚</button>

      <div className="controls" aria-label="Touch controls">
        <div className="stick" ref={stickRef}
          onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); onStickMove(e.clientX, e.clientY); }}
          onPointerMove={(e) => { if (e.buttons || e.pointerType === "touch") { if (stickVec.current || e.pointerType === "touch") onStickMove(e.clientX, e.clientY); } }}
          onPointerUp={onStickEnd} onPointerCancel={onStickEnd}>
          <div className="stick-knob" ref={knobRef} />
        </div>
        <div className="actions">
          <button className="act attack" onPointerDown={() => press("attack", true)} aria-label="Attack">Hit</button>
          <button className="act dodge" onPointerDown={() => press("dodge", true)} aria-label="Dodge">Dodge</button>
          <button className="act sprint" onPointerDown={() => press("sprint", true)} onPointerUp={() => press("sprint", false)} onPointerLeave={() => press("sprint", false)} aria-label="Sprint">Run</button>
          {hud.role === "catcher" && (
            <div className="prop-row">
              {PROP_IDS_ORDER.map((p, i) => (
                <button key={p} className={`prop ${hud.prop === p ? "on" : ""}`} onClick={() => inputApi?.prop(i as 0 | 1 | 2)} aria-label={`Use ${p}`}>{p}</button>
              ))}
            </div>
          )}
        </div>
      </div>

      {hud.paused && (
        <div className="overlay" role="dialog" aria-label="Paused">
          <div className="panel">
            <h2>Paused</h2>
            <div className="row">
              <Button onClick={togglePause}>Resume</Button>
              <Button variant="ghost" onClick={() => setState({ screen: "settings" })}>Settings</Button>
            </div>
            <Button variant="danger" onClick={() => requestAction("room:leave", {}).catch(() => undefined)}>Leave match</Button>
            {!isOwner && <p className="muted small">Only the host can pause a multiplayer match.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
