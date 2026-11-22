import { useEffect } from "react";
import { useAppState, setState, getState } from "./app/store.ts";
import { startSession, net } from "./app/session.ts";
import { Menu } from "./screens/Menu.tsx";
import { SinglePlayer, Multiplayer } from "./screens/Setup.tsx";
import { Lobby } from "./screens/Lobby.tsx";
import { Dice } from "./screens/Dice.tsx";
import { Game } from "./screens/Game.tsx";
import { End } from "./screens/End.tsx";
import { Settings } from "./screens/Settings.tsx";
import { HowTo } from "./screens/HowTo.tsx";
import { Stats } from "./screens/Stats.tsx";

export function App() {
  const screen = useAppState((s) => s.screen);
  const toast = useAppState((s) => s.toast);
  const conn = useAppState((s) => s.conn);
  const publicId = useAppState((s) => s.publicId);

  useEffect(() => {
    startSession();
    const name = getState().name || "Guest";
    net.connect({ name, avatar: getState().avatar });
    return () => net.close();
  }, []);

  let body;
  switch (screen) {
    case "menu": body = <Menu />; break;
    case "single": body = <SinglePlayer />; break;
    case "multi": body = <Multiplayer />; break;
    case "lobby": body = <Lobby />; break;
    case "dice": body = <Dice />; break;
    case "game": body = <Game />; break;
    case "ended": body = <End />; break;
    case "settings": body = <Settings />; break;
    case "howto": body = <HowTo />; break;
    case "stats": body = <Stats />; break;
  }

  return (
    <div className={`app screen-${screen}`}>
      {(conn === "reconnecting" || conn === "connecting") && screen !== "game" && (
        <div className="banner">Connecting to the game server…</div>
      )}
      {!publicId && screen === "menu" && conn === "open" && <div className="banner">Setting up your session…</div>}
      {body}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
