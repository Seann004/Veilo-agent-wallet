import { z } from "zod";

const uuid = z.uuid();
const isoTimestamp = z.iso.datetime({ offset: false });
const text = (max: number) => z.string().trim().min(1).max(max);

/** Default per-task run bounds for research and content agents. */
export const TASK_RUN_BOUNDS = {
  maxToolCalls: 8,
  maxPaidPurchases: 3,
  maxPlanningCalls: 2,
  maxDurationMs: 10 * 60_000,
} as const;

/** Owner input for a research task (Prince). */
export const researchTaskInputSchema = z
  .object({
    question: text(1000),
    /** Optional owner-suggested sources; only approved origins are ever fetched. */
    sources: z.array(z.url({ protocol: /^https?$/ })).max(10).default([]),
    deadline: isoTimestamp.optional(),
    /** Agent that may receive this brief after the owner approves a handoff. */
    handoffToAgentId: uuid.optional(),
  })
  .strict();
export type ResearchTaskInput = z.infer<typeof researchTaskInputSchema>;

/** Owner campaign brief for a content task (Mira). */
export const campaignBriefSchema = z
  .object({
    topic: text(500),
    audience: text(500),
    channels: z.array(text(60)).length(3),
    voice: text(300),
    deliverables: text(500).default("Three channel drafts and a seven-day content calendar"),
    deadline: isoTimestamp.optional(),
    /** First planning date of the seven-day calendar (planning only, never a publish time). */
    startDate: z.iso.date().optional(),
    /** Owner-approved handoff whose research is attached to this task. */
    handoffId: uuid.optional(),
  })
  .strict();
export type CampaignBrief = z.infer<typeof campaignBriefSchema>;

export const REVIEW_STATES = ["draft", "needs_review", "approved_for_export", "archived"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const calendarEntrySchema = z
  .object({
    day: z.number().int().min(1).max(7),
    date: z.iso.date().nullable(),
    channel: text(60),
    draftArtifactId: uuid.nullable(),
    action: text(500),
  })
  .strict();
export type CalendarEntry = z.infer<typeof calendarEntrySchema>;

export const calendarSchema = z
  .array(calendarEntrySchema)
  .length(7)
  .refine((entries) => new Set(entries.map((e) => e.day)).size === 7, "calendar must cover days 1-7 exactly once");

/** Owner edit of a draft or calendar. Creates a new owner revision; never triggers inference. */
export const contentPatchSchema = z
  .object({
    title: text(200).optional(),
    content: z.string().min(1).max(200_000).optional(),
    calendar: calendarSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "at least one field is required")
  .refine((v) => !(v.content !== undefined && v.calendar !== undefined), "send content or calendar, not both");

export const contentReviewSchema = z.object({ state: z.enum(REVIEW_STATES) }).strict();

export const contentQuerySchema = z
  .object({
    kind: z.enum(["research_brief", "content_draft", "content_calendar"]).optional(),
    state: z.enum(REVIEW_STATES).optional(),
    agentId: uuid.optional(),
  })
  .strict();

export const handoffDecisionSchema = z.object({ decision: z.enum(["approve", "reject"]) }).strict();

/** Runner request for an operator-sponsored planning call (not a model tool). */
export const planningProxyRequestSchema = z
  .object({
    taskId: uuid,
    purpose: text(200),
    messages: z
      .array(z.object({ role: z.enum(["system", "user"]), content: z.string().min(1).max(16_000) }).strict())
      .min(1)
      .max(8),
    maxOutputTokens: z.number().int().positive().max(1_000).optional(),
  })
  .strict();

export const jobClaimSchema = z
  .object({
    workerId: z.string().regex(/^[A-Za-z0-9:._-]{1,64}$/),
    leaseMs: z.number().int().min(5_000).max(15 * 60_000).default(60_000),
  })
  .strict();

export const jobHeartbeatSchema = z
  .object({
    workerId: z.string().regex(/^[A-Za-z0-9:._-]{1,64}$/),
    version: z.string().regex(/^[0-9]{1,18}$/),
    leaseMs: z.number().int().min(5_000).max(15 * 60_000).default(60_000),
  })
  .strict();

export const jobCompleteSchema = z
  .object({
    workerId: z.string().regex(/^[A-Za-z0-9:._-]{1,64}$/),
    version: z.string().regex(/^[0-9]{1,18}$/),
    outcome: z.enum(["completed", "failed"]),
    taskState: z.enum(["completed", "incomplete", "failed"]).optional(),
    result: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
