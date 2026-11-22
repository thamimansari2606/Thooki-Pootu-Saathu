import { useEffect, useState } from "react";
import { Button, Panel, Screen } from "./common.tsx";
import { setState, useAppState } from "../app/store.ts";
import { httpUrl } from "../app/session.ts";

interface Profile { name: string; totalGames: number; wins: number; losses: number; knockouts: number; survivalMs: number }

export function Stats() {
  const publicId = useAppState((s) => s.publicId);
  const [me, setMe] = useState<Profile | null>(null);
  const [board, setBoard] = useState<Array<Profile & { playerId: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch(httpUrl("/api/leaderboard")).then((r) => r.json()).then((j) => setBoard(j.players ?? [])).catch(() => setError("Leaderboard unavailable."));
    if (publicId) fetch(httpUrl(`/api/profile/${publicId}`)).then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => undefined);
  }, [publicId]);
  return (
    <Screen>
      <Panel title="Statistics">
        {me ? (
          <div className="stats">
            <div><b>{me.totalGames}</b> games</div>
            <div><b>{me.wins}</b> wins</div>
            <div><b>{me.losses}</b> losses</div>
            <div><b>{me.knockouts}</b> knockouts</div>
            <div><b>{Math.round(me.survivalMs / 60000)}</b> min survived</div>
          </div>
        ) : (
          <p className="muted">Play a match to start your statistics. Guest play is saved on this device.</p>
        )}
        <h3>Top players</h3>
        {error && <p className="warn">{error}</p>}
        <ol className="rankings">
          {board.map((p, i) => (
            <li key={p.playerId}><span className="rank">{i + 1}</span><span className="rname">{p.name}</span><span className="rstat">{p.wins}W / {p.totalGames}G</span></li>
          ))}
        </ol>
        <div className="row"><Button variant="ghost" onClick={() => setState({ screen: "menu" })}>Back</Button></div>
      </Panel>
    </Screen>
  );
}
