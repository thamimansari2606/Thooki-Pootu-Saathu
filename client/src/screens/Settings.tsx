import { Button, Panel, Screen } from "./common.tsx";
import { setState, useAppState } from "../app/store.ts";
import { sfx } from "../audio/sfx.ts";
import { useState } from "react";

export function Settings() {
  const quality = useAppState((s) => s.quality);
  const zoom = useAppState((s) => s.zoom);
  const [audio, setAudio] = useState(sfx.current);
  const update = (patch: Partial<typeof audio>) => {
    sfx.unlock();
    sfx.update(patch);
    setAudio({ ...audio, ...patch });
  };
  return (
    <Screen>
      <Panel title="Settings">
        <h3>Sound</h3>
        <label className="field">Master volume
          <input type="range" min={0} max={1} step={0.05} value={audio.master} onChange={(e) => update({ master: Number(e.target.value) })} />
        </label>
        <label className="field">Music
          <input type="range" min={0} max={1} step={0.05} value={audio.music} onChange={(e) => update({ music: Number(e.target.value) })} />
        </label>
        <label className="field">Sound effects
          <input type="range" min={0} max={1} step={0.05} value={audio.sfx} onChange={(e) => update({ sfx: Number(e.target.value) })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={audio.muted} onChange={(e) => update({ muted: e.target.checked })} /> Mute everything
        </label>

        <h3>Graphics</h3>
        <div className="chips">
          {(["low", "medium", "high"] as const).map((q) => (
            <button key={q} className={`chip ${quality === q ? "on" : ""}`} onClick={() => { localStorage.setItem("tps.quality", q); setState({ quality: q }); }}>{q}</button>
          ))}
        </div>
        <label className="field">Camera distance
          <input type="range" min={0.6} max={1.8} step={0.05} value={zoom} onChange={(e) => setState({ zoom: Number(e.target.value) })} />
        </label>
        <div className="row">
          <Button variant="ghost" onClick={() => setState({ screen: "menu" })}>Back</Button>
        </div>
      </Panel>
    </Screen>
  );
}
