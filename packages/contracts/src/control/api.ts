import { z } from "zod";
import { isAddress } from "@solana/kit";
import { ERROR_CODES, type ErrorCode } from "../errors";
import { baseUnitString } from "./amounts";
import {
  AGENT_ROLES,
  PAYMENT_PATHS,
  agentPolicyInputSchema,
  workspacePolicyInputSchema,
} from "./policy";

/**
 * Transport-level codes used alongside the domain error codes: missing/invalid credentials,
 * CSRF or origin failures, malformed input, unknown resources, capabilities whose backing
 * service is not available yet, and unexpected internal failures.
 */
export const TRANSPORT_ERROR_CODES = ["UNAUTHENTICATED", "FORBIDDEN", "INVALID_REQUEST", "NOT_FOUND", "NOT_READY", "INTERNAL_ERROR"] as const;
export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];
export type ApiErrorCode = ErrorCode | TransportErrorCode;
export const API_ERROR_CODES: readonly ApiErrorCode[] = [...ERROR_CODES, ...TRANSPORT_ERROR_CODES];

export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  POLICY_DENIED: 403,
  BUDGET_EXCEEDED: 409,
  SERVICE_NOT_ALLOWED: 403,
  PRICE_CHANGED: 409,
  WRONG_NETWORK: 409,
  WRONG_MINT: 409,
  ACCOUNT_STOPPED: 423,
  APPROVAL_REQUIRED: 202,
  PRIVACY_WARNING: 409,
  NOTE_PENDING: 409,
  SETTLEMENT_UNCERTAIN: 409,
  QUOTE_EXPIRED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PROVIDER_UNAVAILABLE: 503,
  PAID_NO_RESULT: 409,
  RECOVERY_REQUIRED: 409,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  NOT_READY: 503,
  INTERNAL_ERROR: 500,
};

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
}

const uuid = z.uuid();
const solanaAddress = z.string().refine((v) => isAddress(v), "must be a base58 Solana address");
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex SHA-256 digest");
const isoTimestamp = z.iso.datetime({ offset: false });
const shortText = (max: number) => z.string().trim().min(1).max(max);

export const sessionChallengeRequestSchema = z.object({ address: solanaAddress }).strict();

export const sessionVerifyRequestSchema = z
  .object({
    address: solanaAddress,
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    /** Base58 Ed25519 signature over the exact challenge message bytes (UTF-8). */
    signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/),
    /** Optional echo of the signed message; must equal the issued message exactly. */
    message: z.string().max(2048).optional(),
  })
  .strict();

export const agentTriggerSchema = z.record(z.string(), z.union([z.string().max(256), z.number().int(), z.boolean()]));

export const createAgentRequestSchema = z
  .object({
    name: shortText(64),
    role: z.enum(AGENT_ROLES),
    description: shortText(500).optional(),
    trigger: agentTriggerSchema.optional(),
    modelProfile: shortText(128).optional(),
    policy: agentPolicyInputSchema,
  })
  .strict();

export const agentConfigPatchSchema = z
  .object({
    name: shortText(64).optional(),
    description: shortText(500).optional(),
    trigger: agentTriggerSchema.optional(),
    modelProfile: shortText(128).optional(),
    /** Creates a new draft policy version. */
    policy: agentPolicyInputSchema.optional(),
    /** Activates an existing draft version (owner activation). */
    activatePolicyVersion: z.number().int().min(1).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "at least one field is required");

export const runAgentRequestSchema = z
  .object({
    objective: shortText(4000).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    taskLimitTestUsdc: baseUnitString.optional(),
    deadline: isoTimestamp.optional(),
    /** Stable trigger identity; repeated runs with the same key return the same job. */
    triggerKey: z.string().regex(/^[A-Za-z0-9:._-]{1,128}$/).optional(),
  })
  .strict();

export const workspacePolicyRequestSchema = z
  .object({
    policy: workspacePolicyInputSchema.optional(),
    activateVersion: z.number().int().min(1).optional(),
  })
  .strict()
  .refine((v) => v.policy !== undefined || v.activateVersion !== undefined, "policy or activateVersion is required");

export const workspaceStopRequestSchema = z.object({ reason: shortText(500).optional() }).strict();

export const purchaseIntentRequestSchema = z
  .object({
    /** Logical purchase key chosen by the worker; repeats return the same operation. */
    idempotencyKey: z.string().regex(/^[A-Za-z0-9:._-]{1,128}$/),
    serviceId: uuid,
    sku: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    paymentPath: z.enum(PAYMENT_PATHS),
    requestDigest: sha256Hex,
    taskId: uuid.optional(),
    rationale: shortText(1000).optional(),
    /** Exact SKU input; must hash to requestDigest. Required for the purchase to be executed. */
    input: z.record(z.string(), z.unknown()).optional(),
    /** Ignored when equal to the credential's agent; any other value is rejected. */
    agentId: uuid.optional(),
  })
  .strict();
export type PurchaseIntentRequest = z.infer<typeof purchaseIntentRequestSchema>;

export const purchaseDecisionRequestSchema = z.object({ decision: z.enum(["approve", "reject"]) }).strict();

export const reconcileRequestSchema = z.object({}).strict();

export const saveArtifactRequestSchema = z
  .object({
    taskId: uuid,
    kind: z.enum(["research_brief", "content_draft", "content_calendar"]),
    title: shortText(200),
    content: z.string().min(1).max(200_000),
    citations: z.array(z.object({ url: z.url(), title: shortText(300).optional() }).strict()).max(100).default([]),
    sourcePurchaseIds: z.array(uuid).max(20).default([]),
    artifactId: uuid.optional(),
  })
  .strict();

export const handoffRequestSchema = z
  .object({ artifactId: uuid, toAgentId: uuid, note: shortText(1000).optional() })
  .strict();

export const activityQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.coerce.number().int().min(1).optional(),
  })
  .strict();
