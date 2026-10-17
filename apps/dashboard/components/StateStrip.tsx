import { stateSummaries, type StateTone } from "../lib/labels";
import type { Purchase } from "../lib/types";

const GLYPH: Record<StateTone, string> = { ok: "✓", wait: "…", problem: "!", idle: "·" };

/** Payment, fulfilment and recovery shown side by side; each has its own text, never colour alone. */
export function StateStrip({ purchase }: { purchase: Pick<Purchase, "states" | "paymentPath"> }) {
  return (
    <ul className="state-strip" aria-label="Payment, fulfilment and recovery states">
      {stateSummaries(purchase).map((s) => (
        <li key={s.group} className={`state state-${s.tone}`}>
          <span className="state-group">{s.group}</span>
          <span className="state-text">
            <span aria-hidden="true">{GLYPH[s.tone]} </span>
            {s.text}
          </span>
        </li>
      ))}
    </ul>
  );
}
