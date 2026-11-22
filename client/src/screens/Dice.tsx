import { useEffect, useState } from "react";
import { Panel, Screen } from "./common.tsx";
import { useAppState, setState } from "../app/store.ts";
import { requestAction } from "../app/session.ts";

const FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

/** Secret selection and the server-driven roll reveal. The chosen number is never shown to others. */
export function Dice() {
  // Separate primitive selectors: selectors that build new objects would loop in useSyncExternalStore.
  const rolling = useAppState((s) => s.rolling);
  const diceTotal = useAppState((s) => s.diceTotal);
  const diceSelected = useAppState((s) => s.diceSelected);
  const myDice = useAppState((s) => s.myDice);
  const catcherRevealed = useAppState((s) => s.catcherRevealed);
  const room = useAppState((s) => s.room);
  const publicId = useAppState((s) => s.publicId);
  const [shown, setShown] = useState(1);

  useEffect(() => {
    if (!rolling) return;
    const t = window.setInterval(() => setShown(1 + Math.floor(Math.random() * 6)), 110);
    return () => clearInterval(t);
  }, [rolling]);

  const choose = async (n: number) => {
    if (myDice !== null) return;
    setState({ myDice: n });
    try {
      await requestAction("match:select", { value: n });
    } catch {
      setState({ myDice: null });
    }
  };

  if (rolling) {
    const final = rolling.rolls[rolling.rolls.length - 1];
    const catcherName = room?.players.find((p) => p.publicId === rolling.catcherId)?.name ?? "";
    const iAmCatcher = publicId === rolling.catcherId;
    return (
      <Screen className="dice-roll">
        <Panel>
          <div className="dice-face big">{FACES[(catcherRevealed ? final : shown) - 1]}</div>
          <p className="muted">Rolls so far: {rolling.rolls.map((r) => FACES[r - 1]).join(" ")}</p>
          {catcherRevealed && (
            <div className="announce">
              <h2>{iAmCatcher ? "You are the CATCHER!" : `${catcherName} is the CATCHER!`}</h2>
              <p>{iAmCatcher ? "Tag everyone. You have three props: 1 rod, 2 hammer, 3 slipper." : "Run, hide and dodge for five minutes!"}</p>
            </div>
          )}
        </Panel>
      </Screen>
    );
  }

  return (
    <Screen>
      <Panel title="Pick your secret number">
        <p className="muted">Choose one number from 1 to 6. Nobody else sees it. The dice roll when everyone has picked.</p>
        <div className="dice-grid">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <button
              key={n}
              className={`die ${myDice === n ? "picked" : ""}`}
              disabled={myDice !== null}
              onClick={() => choose(n)}
              aria-label={`Pick ${n}`}
            >
              <span className="die-face">{FACES[n - 1]}</span>
              <span className="die-num">{n}</span>
            </button>
          ))}
        </div>
        <p className="status">{myDice !== null ? `You picked ${myDice}. Waiting for others…` : "Pick a number to continue."}</p>
        <p className="muted small">Chosen so far: {diceSelected} of {diceTotal}</p>
      </Panel>
    </Screen>
  );
}
