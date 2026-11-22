import { Button, Panel, Screen, AVATAR_EMOJI } from "./common.tsx";
import { setState, useAppState, getState, toast } from "../app/store.ts";
import { requestAction, net } from "../app/session.ts";

export function Lobby() {
  const room = useAppState((s) => s.room);
  const publicId = useAppState((s) => s.publicId);
  if (!room) {
    return (
      <Screen>
        <Panel>
          <p>Connecting to the room…</p>
          <Button variant="ghost" onClick={() => setState({ screen: "menu" })}>Back</Button>
        </Panel>
      </Screen>
    );
  }
  const me = room.players.find((p) => p.publicId === publicId);
  const isOwner = room.ownerPublicId === publicId;
  const everyoneReady = room.players.every((p) => p.publicId === room.ownerPublicId || p.ready);
  const slots = Array.from({ length: room.maxPlayers }, (_, i) => room.players[i] ?? null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(room.code);
      toast("Room code copied.");
    } catch {
      toast(`Share this code: ${room.code}`);
    }
  };
  const leave = () => requestAction("room:leave", {}).catch(() => undefined);

  return (
    <Screen>
      <Panel title={`Room ${room.code}`}>
        <div className="row between">
          <p className="muted">Share the code with friends. {room.players.length}/{room.maxPlayers} players.</p>
          <Button variant="ghost" onClick={copy}>Copy code</Button>
        </div>
        <div className="slots">
          {slots.map((p, i) =>
            p ? (
              <div key={p.publicId} className={`slot ${p.ready ? "ready" : ""} ${p.connected ? "" : "offline"}`}>
                <div className="avatar">{AVATAR_EMOJI[p.avatar] ?? "🙂"}</div>
                <div className="slot-name">
                  {p.name}
                  {p.publicId === room.ownerPublicId && <span className="badge">host</span>}
                  {p.isBot && <span className="badge bot">AI</span>}
                </div>
                <div className="slot-status">
                  {!p.connected ? "disconnected" : p.isBot ? "ready" : p.ready ? "ready ✓" : "not ready"}
                </div>
              </div>
            ) : (
              <div key={`empty-${i}`} className="slot empty">Open slot</div>
            ),
          )}
        </div>
        <div className="row">
          {!isOwner && me && (
            <Button variant={me.ready ? "ghost" : "primary"} onClick={() => requestAction("room:ready", { ready: !me.ready }).catch(() => undefined)}>
              {me.ready ? "Not ready" : "I'm ready"}
            </Button>
          )}
          {isOwner && (
            <Button variant="warm" disabled={!everyoneReady || room.players.length < 2} onClick={() => requestAction("room:start", {}).catch(() => undefined)}>
              Start match
            </Button>
          )}
          <Button variant="danger" onClick={leave}>Leave room</Button>
        </div>
        {isOwner && <p className="muted small">You are the host. Start when everyone is ready (at least two players).</p>}
        {!net.connState.includes("open") && <p className="warn">Reconnecting…</p>}
      </Panel>
      <p className="muted small">Your name: {getState().name}</p>
    </Screen>
  );
}
