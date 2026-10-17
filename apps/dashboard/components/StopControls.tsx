"use client";

import { api } from "../lib/api";
import { useAction } from "./hooks";
import { ConfirmButton, ErrorNotice } from "./ui";

export const STOP_KEEPS_RECOVERY = "Stopping blocks all new spending authority. Payments already authorized stay visible, and owner recovery and public exit remain available.";

/** Global emergency stop. It never disables recovery or public exit. */
export function EmergencyStop({ stopped, onChanged }: { stopped: boolean; onChanged: () => void | Promise<void> }) {
  const action = useAction();
  return (
    <div className="stop-box" role="group" aria-label="Global emergency stop">
      <p className="small">{STOP_KEEPS_RECOVERY}</p>
      {stopped ? (
        <ConfirmButton
          label="Resume workspace"
          confirmLabel="Confirm resume"
          warning="Agents regain authority within their own policies. Paused or revoked agents stay stopped."
          disabled={action.busy}
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
          warning="All new authority stops now. Released payments may still settle."
          disabled={action.busy}
          onConfirm={() =>
            void action.run(async () => {
              await api("control", "/workspace/stop", { method: "POST", body: { reason: "owner emergency stop from dashboard" } });
              await onChanged();
            })
          }
        />
      )}
      <ErrorNotice error={action.error} />
    </div>
  );
}
