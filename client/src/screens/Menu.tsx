import { Button, Panel, Screen } from "./common.tsx";
import { setState, useAppState, getState, toast } from "../app/store.ts";
import { net, resetMatchLocal, requestAction } from "../app/session.ts";
import { Logo } from "./Logo.tsx";
import { sfx } from "../audio/sfx.ts";

export function Menu() {
  const name = useAppState((s) => s.name);
  const conn = useAppState((s) => s.conn);
  const requireName = (): string | null => {
    const n = getState().name.trim();
    if (!n) {
      toast("Enter a name first.");
      return null;
    }
    localStorage.setItem("tps.name", n);
    return n;
  };
  const go = async (screen: "single" | "multi" | "settings" | "howto" | "stats") => {
    sfx.unlock(); // browsers only allow audio after a user gesture
    if ((screen === "single" || screen === "multi") && !requireName()) return;
    if (screen === "single" || screen === "multi") {
      // Push the typed name to the server before any room is created with it.
      await requestAction("profile:update", { name: getState().name.trim() }).catch(() => undefined);
    }
    resetMatchLocal();
    setState({ screen });
  };
  return (
    <Screen className="menu">
      <Logo />
      <Panel>
        <label className="field">
          <span>Your name</span>
          <input
            maxLength={16}
            value={name}
            placeholder="Player name"
            onChange={(e) => setState({ name: e.target.value })}
          />
        </label>
        <div className="menu-buttons">
          <Button onClick={() => go("single")}>Single Player</Button>
          <Button onClick={() => go("multi")}>Multiplayer</Button>
          <Button variant="ghost" onClick={() => go("stats")}>Statistics</Button>
          <Button variant="ghost" onClick={() => go("howto")}>How to Play</Button>
          <Button variant="ghost" onClick={() => go("settings")}>Settings</Button>
        </div>
        <p className="muted small">Connection: {conn === "open" ? "online" : conn}. Guest play, no sign-up needed.</p>
      </Panel>
      <p className="muted tiny">Tip: {net ? "Tag the others with your props. Survive for five minutes." : ""}</p>
    </Screen>
  );
}
