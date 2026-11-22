import { useState } from "react";
import { Button, Panel, Screen, AVATAR_EMOJI } from "./common.tsx";
import { setState, useAppState, getState, toast } from "../app/store.ts";
import { net, requestAction } from "../app/session.ts";
import { AVATARS_LIST } from "./avatars.ts";

export function SinglePlayer() {
  const solo = useAppState((s) => s.solo);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      await requestAction("room:solo", { bots: solo.bots, difficulty: solo.difficulty });
    } catch {
      /* toast already shown */
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen>
      <Panel title="Single Player">
        <p className="muted">Pick how many AI opponents join you. Maximum six players in total.</p>
        <div className="chips" role="radiogroup" aria-label="Opponents">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} className={`chip ${solo.bots === n ? "on" : ""}`} onClick={() => setState((s) => ({ solo: { ...s.solo, bots: n } }))}>
              {n} opponent{n > 1 ? "s" : ""}
            </button>
          ))}
        </div>
        <h3>Difficulty</h3>
        <div className="chips">
          {(["easy", "medium", "hard"] as const).map((d) => (
            <button key={d} className={`chip ${solo.difficulty === d ? "on" : ""}`} onClick={() => setState((s) => ({ solo: { ...s.solo, difficulty: d } }))}>
              {d}
            </button>
          ))}
        </div>
        <div className="row">
          <Button variant="ghost" onClick={() => setState({ screen: "menu" })}>Back</Button>
          <Button variant="warm" disabled={busy || net.connState !== "open"} onClick={start}>Start game</Button>
        </div>
      </Panel>
    </Screen>
  );
}

export function Multiplayer() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const r = await requestAction("room:create", {});
      setState({ roomCode: r.code, screen: "lobby" });
    } catch {
      /* shown */
    } finally {
      setBusy(false);
    }
  };
  const join = async () => {
    if (code.trim().length !== 6) {
      toast("Room codes are 6 characters.");
      return;
    }
    setBusy(true);
    try {
      const r = await requestAction("room:join", { code: code.trim() });
      setState({ roomCode: r.code, screen: "lobby" });
    } catch {
      /* shown */
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen>
      <Panel title="Multiplayer">
        <Button variant="warm" disabled={busy || net.connState !== "open"} onClick={create}>
          Create private room
        </Button>
        <div className="divider">or join with a code</div>
        <div className="row">
          <input
            className="code-input"
            value={code}
            maxLength={6}
            placeholder="ROOM CODE"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <Button disabled={busy || net.connState !== "open"} onClick={join}>Join</Button>
        </div>
        <Button variant="ghost" onClick={() => setState({ screen: "menu" })}>Back</Button>
      </Panel>
      <p className="muted small">Avatars: {AVATARS_LIST.map((a) => AVATAR_EMOJI[a]).join(" ")}</p>
      <p className="muted small">Your name: {getState().name || "(set on main menu)"}</p>
    </Screen>
  );
}
