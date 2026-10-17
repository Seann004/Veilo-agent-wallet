"use client";

import { api } from "../lib/api";
import { useCapability } from "./Shell";
import { useAction } from "./hooks";
import { ConfirmButton, DeniedHint, ErrorNotice } from "./ui";

export const STOP_KEEPS_RECOVERY = "Stops all new spending at once. Payments already sent stay visible, and you can still recover or withdraw funds.";

/** Global emergency stop. It never disables recovery or public exit. */
export function EmergencyStop({ stopped, onChanged }: { stopped: boolean; onChanged: () => void | Promise<void> }) {
  const action = useAction();
  const stop = useCapability("stop");
  return (
    <div className="stop-box" role="group" aria-label="Global emergency stop">
      <p className="small">{STOP_KEEPS_RECOVERY}</p>
      {stopped ? (
        <ConfirmButton
          label="Resume workspace"
          confirmLabel="Confirm resume"
          warning="Active agents can spend again within their limits. Paused agents stay paused."
          disabled={action.busy || !stop.allowed}
          onConfirm={() =>
            void action.run(async () => {
              await api("control", "/workspace/resume", { method: "POST", body: {} });
              await onChanged();
            })
          }
        />
      ) : (
        <ConfirmButton
          label="Emergency stop all agents"
          confirmLabel="Confirm emergency stop"
          danger
          warning="Stop every agent now? Payments already sent may still settle."
          disabled={action.busy || !stop.allowed}
          onConfirm={() =>
            void action.run(async () => {
              await api("control", "/workspace/stop", { method: "POST", body: { reason: "owner emergency stop from dashboard" } });
              await onChanged();
            })
          }
        />
      )}
      <DeniedHint reason={stop.reason} />
      <ErrorNotice error={action.error} />
    </div>
  );
}
