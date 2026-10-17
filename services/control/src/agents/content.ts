import { calendarSchema, type CalendarEntry, type ReviewState } from "@veilo/contracts";
import { immediate } from "@veilo/db";
import { iso, num, type Ledger } from "../context";
import { ControlError } from "../errors";
import { writeAudit } from "../ledger/events";
import { activeAgentPolicy, requireAgent } from "../ledger/workspace";

interface ArtifactRow {
  id: string;
  workspace_id: string;
  task_id: string;
  agent_id: string;
  kind: "research_brief" | "content_draft" | "content_calendar";
  title: string;
  current_revision: bigint;
  review_state: ReviewState;
  created_at_ms: bigint;
  updated_at_ms: bigint;
}

interface RevisionRow {
  revision: bigint;
  content: string;
  citations_json: string;
  source_purchase_ids_json: string;
  author: "agent" | "owner";
  created_at_ms: bigint;
}

function artifact(ledger: Ledger, workspaceId: string, id: string): ArtifactRow {
  const a = ledger.db.prepare(`SELECT * FROM artifact WHERE id = ?`).get(id) as ArtifactRow | undefined;
  if (!a || a.workspace_id !== workspaceId) throw new ControlError("NOT_FOUND", "content not found");
  return a;
}

function revision(ledger: Ledger, a: ArtifactRow): RevisionRow {
  return ledger.db.prepare(`SELECT * FROM artifact_revision WHERE artifact_id = ? AND revision = ?`).get(a.id, a.current_revision) as RevisionRow;
}

export function contentView(ledger: Ledger, a: ArtifactRow): Record<string, unknown> {
  const r = revision(ledger, a);
  const agent = ledger.db.prepare(`SELECT name, role FROM agent WHERE id = ?`).get(a.agent_id) as { name: string; role: string };
  return {
    id: a.id,
    kind: a.kind,
    title: a.title,
    reviewState: a.review_state,
    agent: { id: a.agent_id, name: agent.name, role: agent.role },
    taskId: a.task_id,
    revision: num(a.current_revision),
    lastAuthor: r.author,
    content: r.content,
    calendar: a.kind === "content_calendar" ? parseCalendar(r.content) : null,
    citations: JSON.parse(r.citations_json) as unknown,
    sourcePurchaseIds: JSON.parse(r.source_purchase_ids_json) as unknown,
    publishing: "none — drafts are local; Veilo has no publishing or messaging authority",
    createdAt: iso(a.created_at_ms),
    updatedAt: iso(a.updated_at_ms),
  };
}

function parseCalendar(content: string): CalendarEntry[] | null {
  try {
    const parsed = calendarSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function listContent(ledger: Ledger, workspaceId: string, q: { kind?: string | undefined; state?: string | undefined; agentId?: string | undefined }): Record<string, unknown>[] {
  const rows = ledger.db
    .prepare(
      `SELECT * FROM artifact WHERE workspace_id = ? AND (? IS NULL OR kind = ?) AND (? IS NULL OR review_state = ?) AND (? IS NULL OR agent_id = ?)
       ORDER BY updated_at_ms DESC LIMIT 200`,
    )
    .all(workspaceId, q.kind ?? null, q.kind ?? null, q.state ?? null, q.state ?? null, q.agentId ?? null, q.agentId ?? null) as ArtifactRow[];
  return rows.map((a) => contentView(ledger, a));
}

/**
 * Owner edit: appends an owner revision. It performs no inference, purchase or publishing;
 * editing an approved item returns it to review.
 */
export function editContent(
  ledger: Ledger,
  workspaceId: string,
  id: string,
  patch: { title?: string | undefined; content?: string | undefined; calendar?: CalendarEntry[] | undefined },
  ownerId: string,
): Record<string, unknown> {
  return immediate(ledger.db, () => {
    const a = artifact(ledger, workspaceId, id);
    if (a.review_state === "archived") throw new ControlError("POLICY_DENIED", "archived content must be restored to draft before editing");
    if (patch.calendar !== undefined && a.kind !== "content_calendar") throw new ControlError("INVALID_REQUEST", "calendar edits apply only to calendars");
    let content = patch.content;
    if (a.kind === "content_calendar" && content !== undefined && parseCalendar(content) === null) {
      throw new ControlError("INVALID_REQUEST", "calendar content must be seven valid entries");
    }
    if (patch.calendar !== undefined) content = JSON.stringify(patch.calendar);
    const prev = revision(ledger, a);
    const next = num(a.current_revision) + 1;
    const now = ledger.now();
    ledger.db
      .prepare(
        `INSERT INTO artifact_revision (artifact_id, revision, content, citations_json, source_purchase_ids_json, author, created_at_ms)
         VALUES (?, ?, ?, ?, ?, 'owner', ?)`,
      )
      .run(a.id, next, content ?? prev.content, prev.citations_json, prev.source_purchase_ids_json, now);
    const state: ReviewState = a.review_state === "approved_for_export" ? "needs_review" : a.review_state;
    ledger.db
      .prepare(`UPDATE artifact SET current_revision = ?, title = ?, review_state = ?, updated_at_ms = ? WHERE id = ?`)
      .run(next, patch.title ?? a.title, state, now, a.id);
    writeAudit(ledger, {
      workspaceId,
      scope: `content:${a.id}`,
      actorType: "owner",
      actorId: ownerId,
      action: "content.edit",
      policyResult: "not_applicable",
      details: { revision: next, kind: a.kind, reviewState: state },
    });
    return contentView(ledger, artifact(ledger, workspaceId, id));
  });
}

/** Owner review-state change. Approval marks content ready for manual export; nothing is published. */
export function reviewContent(ledger: Ledger, workspaceId: string, id: string, state: ReviewState, ownerId: string): Record<string, unknown> {
  return immediate(ledger.db, () => {
    const a = artifact(ledger, workspaceId, id);
    if (a.review_state === "archived" && state !== "draft" && state !== "archived") {
      throw new ControlError("POLICY_DENIED", "archived content can only be restored to draft");
    }
    ledger.db.prepare(`UPDATE artifact SET review_state = ?, updated_at_ms = ? WHERE id = ?`).run(state, ledger.now(), a.id);
    writeAudit(ledger, {
      workspaceId,
      scope: `content:${a.id}`,
      actorType: "owner",
      actorId: ownerId,
      action: "content.review",
      policyResult: "not_applicable",
      details: { from: a.review_state, to: state },
    });
    return contentView(ledger, artifact(ledger, workspaceId, id));
  });
}

/** Planning calendar across non-archived calendars, with linked draft titles and states. */
export function calendarView(ledger: Ledger, workspaceId: string): Record<string, unknown> {
  const rows = ledger.db
    .prepare(`SELECT * FROM artifact WHERE workspace_id = ? AND kind = 'content_calendar' AND review_state <> 'archived' ORDER BY updated_at_ms DESC`)
    .all(workspaceId) as ArtifactRow[];
  return {
    note: "Dates are content planning dates, not publishing commitments. Nothing is posted automatically.",
    calendars: rows.map((a) => {
      const entries = parseCalendar(revision(ledger, a).content) ?? [];
      return {
        id: a.id,
        title: a.title,
        reviewState: a.review_state,
        taskId: a.task_id,
        revision: num(a.current_revision),
        entries: entries.map((e) => {
          const draft = e.draftArtifactId
            ? (ledger.db.prepare(`SELECT title, review_state FROM artifact WHERE id = ?`).get(e.draftArtifactId) as { title: string; review_state: string } | undefined)
            : undefined;
          return { ...e, draft: draft ? { title: draft.title, reviewState: draft.review_state } : null };
        }),
      };
    }),
  };
}

/**
 * Owner decision on a handoff. Approval copies the artifact into a new queued task for the
 * receiving agent under that agent's own policy defaults. It starts no job and changes no policy.
 */
export function decideHandoff(ledger: Ledger, workspaceId: string, handoffId: string, decision: "approve" | "reject", ownerId: string): Record<string, unknown> {
  return immediate(ledger.db, () => {
    const h = ledger.db.prepare(`SELECT * FROM handoff_request WHERE id = ?`).get(handoffId) as
      | { id: string; workspace_id: string; artifact_id: string; from_agent_id: string; to_agent_id: string; state: string; note: string | null }
      | undefined;
    if (!h || h.workspace_id !== workspaceId) throw new ControlError("NOT_FOUND", "handoff not found");
    const existingTask = ledger.db.prepare(`SELECT task_id FROM handoff_task WHERE handoff_id = ?`).pluck().get(h.id) as string | undefined;
    if (h.state !== "pending_owner") return { id: h.id, state: h.state, taskId: existingTask ?? null };
    const now = ledger.now();
    if (decision === "reject") {
      ledger.db.prepare(`UPDATE handoff_request SET state = 'rejected', decided_at_ms = ? WHERE id = ?`).run(now, h.id);
      writeAudit(ledger, { workspaceId, scope: `handoff:${h.id}`, actorType: "owner", actorId: ownerId, action: "handoff.reject", policyResult: "denied" });
      return { id: h.id, state: "rejected", taskId: null };
    }
    const target = requireAgent(ledger, workspaceId, h.to_agent_id);
    const policy = activeAgentPolicy(ledger, target.id);
    if (target.status !== "active" || !policy) throw new ControlError("ACCOUNT_STOPPED", "receiving agent is not active");
    const art = artifact(ledger, workspaceId, h.artifact_id);
    const rev = revision(ledger, art);
    const taskId = ledger.newId();
    const input = {
      handoff: {
        id: h.id,
        fromAgentId: h.from_agent_id,
        artifactId: art.id,
        revision: num(art.current_revision),
        title: art.title,
        content: rev.content,
        citations: JSON.parse(rev.citations_json) as unknown,
        note: h.note,
      },
    };
    ledger.db
      .prepare(
        `INSERT INTO task (id, workspace_id, agent_id, objective, input_json, limit_usdc, usage_limit_units, state, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(taskId, workspaceId, target.id, `Approved handoff: ${art.title}`.slice(0, 4000), JSON.stringify(input), policy.task_limit_usdc, policy.task_usage_limit_units, now, now);
    ledger.db.prepare(`INSERT INTO handoff_task (handoff_id, task_id, created_at_ms) VALUES (?, ?, ?)`).run(h.id, taskId, now);
    ledger.db.prepare(`UPDATE handoff_request SET state = 'approved', decided_at_ms = ? WHERE id = ?`).run(now, h.id);
    writeAudit(ledger, {
      workspaceId,
      scope: `handoff:${h.id}`,
      actorType: "owner",
      actorId: ownerId,
      action: "handoff.approve",
      policyResult: "allowed",
      details: { taskId, toAgentId: target.id, artifactId: art.id },
    });
    return { id: h.id, state: "approved", taskId };
  });
}

export function listHandoffs(ledger: Ledger, workspaceId: string): Record<string, unknown>[] {
  const rows = ledger.db
    .prepare(
      `SELECT h.*, t.task_id FROM handoff_request h LEFT JOIN handoff_task t ON t.handoff_id = h.id WHERE h.workspace_id = ? ORDER BY h.created_at_ms DESC`,
    )
    .all(workspaceId) as Array<{ id: string; artifact_id: string; from_agent_id: string; to_agent_id: string; state: string; note: string | null; task_id: string | null; created_at_ms: bigint }>;
  return rows.map((r) => ({ id: r.id, artifactId: r.artifact_id, fromAgentId: r.from_agent_id, toAgentId: r.to_agent_id, state: r.state, note: r.note, taskId: r.task_id, createdAt: iso(r.created_at_ms) }));
}
