import { immediate } from "@veilo/db";
import { iso, type Ledger } from "../context";
import { ControlError } from "../errors";
import { redactText } from "../ledger/events";
import type { AgentRow } from "../ledger/workspace";
import { ownTask } from "./work";

export const PROGRESS_LABEL_MAX = 120;
export const PROGRESS_KEEP = 20;

const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#]+)[^\s]*/gi;
/** Long unbroken runs look like keys, signatures or tokens rather than words. */
const OPAQUE = /[A-Za-z0-9+/=_]{32,}/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** A progress label reduced to plain text: links become their host, secret-shaped runs are removed. */
export function sanitizeProgressLabel(raw: string): string {
  const text = redactText(raw)
    .replace(CONTROL_CHARS, " ")
    .replace(URL_LIKE, (_m, authority: string) => authority.slice(authority.lastIndexOf("@") + 1))
    .replace(OPAQUE, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > PROGRESS_LABEL_MAX ? `${text.slice(0, PROGRESS_LABEL_MAX - 1)}…` : text;
}

/** Records one step for a running task the worker's agent owns, keeping only the newest entries. */
export function recordProgress(ledger: Ledger, agent: AgentRow, taskId: string, raw: string): { label: string; at: string } {
  const label = sanitizeProgressLabel(raw);
  if (label === "") throw new ControlError("INVALID_REQUEST", "label is empty");
  const at = ledger.now();
  immediate(ledger.db, () => {
    const task = ownTask(ledger, agent.id, taskId);
    if (task.state !== "running") throw new ControlError("POLICY_DENIED", `task is ${task.state}`);
    ledger.db.prepare(`INSERT INTO task_progress (task_id, label, at_ms) VALUES (?, ?, ?)`).run(taskId, label, at);
    ledger.db
      .prepare(`DELETE FROM task_progress WHERE task_id = ? AND id NOT IN (SELECT id FROM task_progress WHERE task_id = ? ORDER BY id DESC LIMIT ?)`)
      .run(taskId, taskId, PROGRESS_KEEP);
  });
  return { label, at: iso(at) };
}

/** Progress for each listed task, oldest step first. */
export function progressFor(ledger: Ledger, taskIds: readonly string[]): Map<string, Array<{ label: string; at: string }>> {
  const out = new Map<string, Array<{ label: string; at: string }>>();
  if (taskIds.length === 0) return out;
  const rows = ledger.db
    .prepare(`SELECT task_id, label, at_ms FROM task_progress WHERE task_id IN (${taskIds.map(() => "?").join(", ")}) ORDER BY id`)
    .all(...taskIds) as Array<{ task_id: string; label: string; at_ms: bigint }>;
  for (const r of rows) {
    const list = out.get(r.task_id) ?? [];
    list.push({ label: r.label, at: iso(r.at_ms) });
    out.set(r.task_id, list);
  }
  return out;
}
