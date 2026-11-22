import { Button, Panel, Screen } from "./common.tsx";
import { setState } from "../app/store.ts";

export function HowTo() {
  return (
    <Screen>
      <Panel title="How to Play">
        <ol className="howto">
          <li>Everyone secretly picks a number from 1 to 6. Nobody sees your choice.</li>
          <li>The dice roll until a picked number comes up. One matching player is the CATCHER.</li>
          <li>The catcher has three props: rod (10 damage), hammer (20), slipper (10). Switch with 1, 2, 3.</li>
          <li>Survivors run, hide and dodge. Survivors cannot attack.</li>
          <li>Survive five minutes with at least one player standing to win as survivors.</li>
          <li>If every survivor is knocked out, the catcher wins.</li>
        </ol>
        <h3>Controls</h3>
        <p className="small"><b>Desktop:</b> WASD or arrow keys to move · Shift to sprint · Space to dodge · J or Enter to hit · 1/2/3 to switch props · Esc to pause.</p>
        <p className="small"><b>Phone and tablet:</b> drag the stick on the left · Run, Dodge and Hit on the right.</p>
        <div className="row">
          <Button variant="ghost" onClick={() => setState({ screen: "menu" })}>Back</Button>
        </div>
      </Panel>
    </Screen>
  );
}
