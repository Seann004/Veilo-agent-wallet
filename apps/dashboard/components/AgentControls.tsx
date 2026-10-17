"use client";

import { api } from "../lib/api";
import type { Agent } from "../lib/types";
import { useAction } from "./hooks";
import { ConfirmButton, ErrorNotice } from "./ui";

/**
 * Per-agent stop paths. Pause and revoke stop new authority only; already released payments stay
 * visible and owner recovery/public exit remain available.
 */
export function AgentControls({ agent, onChanged, compact }: { agent: Agent; onChanged: () => void | Promise<void>; compact?: boolean }) {
  const action = useAction();
  const post = (verb: string) =>
    action.run(async () => {
      await api("control", `/agents/${agent.id}/${verb}`, { method: "POST", body: {} });
      await onChanged();
    });
  const terminal = agent.status === "revoked" || agent.status === "archived";
  return (
    <div className={compact ? "actions actions-compact" : "actions"} role="group" aria-label={`${agent.name} authority controls`}>
      {agent.status === "paused" ? (
        <button type="button" className="btn" disabled={action.busy} onClick={() => void post("resume")} aria-label={compact ? `Resume ${agent.name}` : undefined}>
          {compact ? "Resume" : `Resume ${agent.name}`}
        </button>
      ) : (
        <button type="button" className="btn" disabled={action.busy || terminal || agent.status === "draft"} onClick={() => void post("pause")} aria-label={compact ? `Pause ${agent.name}` : undefined}>
          {compact ? "Pause" : `Pause ${agent.name}`}
        </button>
      )}
      <ConfirmButton
        label={`Revoke ${agent.name}`}
        display={compact ? "Revoke" : undefined}
        confirmLabel={`Confirm revoke ${agent.name}`}
        danger
        disabled={action.busy || terminal}
        warning="Revocation is permanent. Payments already authorized stay visible and recoverable."
        onConfirm={() => void post("revoke")}
      />
      <ConfirmButton
        label={`Archive ${agent.name}`}
        display={compact ? "Archive" : undefined}
        confirmLabel={`Confirm archive ${agent.name}`}
        disabled={action.busy || agent.status === "archived"}
        warning="Archiving revokes authority and keeps all records; archived agents cannot schedule work."
        onConfirm={() => void post("archive")}
      />
      <ErrorNotice error={action.error} />
    </div>
  );
}
