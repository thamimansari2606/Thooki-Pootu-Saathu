import { Button, Panel, Screen } from "./common.tsx";
import { setState, useAppState, getState, toast } from "../app/store.ts";
import { requestAction, resetMatchLocal } from "../app/session.ts";

export function End() {
  const end = useAppState((s) => s.end);
  const room = useAppState((s) => s.room);
  const publicId = useAppState((s) => s.publicId);
  if (!end) return null;
  const me = end.players.find((p) => p.publicId === publicId);
  const iWon = me ? (end.winner === "catcher" ? me.role === "catcher" : me.role === "survivor" && (me.placement ?? 99) <= 1 + end.players.filter((p) => p.role === "survivor").length) : false;
  const sorted = [...end.players].sort((a, b) => (a.placement ?? 99) - (b.placement ?? 99));
  const isOwner = room?.ownerPublicId === publicId;
  const headline = end.winner === "catcher" ? "The catcher wins!" : "Survivors win!";
  const reason = end.reason === "timeout" ? "Time ran out and survivors were still standing." : "Every survivor was tagged out.";

  const replay = async () => {
    resetMatchLocal();
    try {
      if (room && room.players.some((p) => p.isBot)) {
        // Leave the finished room first: a player can only be seated in one room at a time.
        await requestAction("room:leave", {}).catch(() => undefined);
        await requestAction("room:solo", { bots: room.players.filter((p) => p.isBot).length, difficulty: getState().solo.difficulty });
      } else {
        await requestAction("room:start", {});
      }
      setState({ end: null });
    } catch {
      toast("Could not start a new match.");
    }
  };
  const menu = async () => {
    resetMatchLocal();
    await requestAction("room:leave", {}).catch(() => undefined);
    setState({ screen: "menu", end: null, room: null, roomCode: null });
  };

  return (
    <Screen className="end">
      <Panel>
        <div className={`headline ${iWon ? "win" : "lose"}`}>{iWon ? "🎉 You win!" : headline}</div>
        <p className="muted">{headline} {reason}</p>
        <h3>Rankings</h3>
        <ol className="rankings">
          {sorted.map((p) => (
            <li key={p.publicId} className={p.publicId === publicId ? "me" : ""}>
              <span className="rank">{p.placement ?? "-"}</span>
              <span className="rname">{p.name}</span>
              <span className="rrole">{p.role === "catcher" ? "catcher" : "survivor"}</span>
              <span className="rstat">KO {p.knockouts} · dmg {p.damageDealt}</span>
            </li>
          ))}
        </ol>
        <div className="row">
          {(isOwner || room?.players.some((p) => p.isBot)) && <Button variant="warm" onClick={replay}>Play again</Button>}
          <Button variant="ghost" onClick={menu}>Main menu</Button>
        </div>
      </Panel>
    </Screen>
  );
}
