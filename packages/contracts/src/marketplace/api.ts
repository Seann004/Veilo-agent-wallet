import { z } from "zod";
import { MANAGED_TEMPLATES, quoteSchema, resultEnvelopeSchema } from "./schemas";
import { TOOL_PROVIDERS } from "./workflows";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/, "must be a base58 transaction signature");

/**
 * Seller host → marketplace (bearer seller-host credential). The host quotes a job only while
 * the marketplace reports it awaiting payment with the same quote digest, and runs it only
 * after the marketplace has verified a finalized receipt and granted a lease.
 */
export const sellerHostJobViewSchema = z
  .object({
    jobId: z.uuid(),
    state: z.string(),
    listingVersionId: z.uuid(),
    quote: quoteSchema,
    runtime: z
      .object({
        kind: z.enum(["managed_template", "remote_endpoint"]),
        template: z.enum(MANAGED_TEMPLATES).nullable(),
        runtimeVersionId: z.string(),
        modelId: z.string().nullable(),
        maxOutputTokens: z.number().int().positive(),
        sellerInstructions: z.string(),
        outputFormat: z.enum(["markdown", "json"]),
        sections: z.array(z.string()),
      })
      .strict(),
    inputs: z.array(z.object({ kind: z.string(), body: z.string(), createdAt: z.string() }).strict()),
    /** The listing's pinned provider tool, when the listing is a provider adapter on the seller's own host. */
    tool: z
      .object({ provider: z.enum(TOOL_PROVIDERS), toolName: z.string(), manifestSha256: z.string().regex(/^[0-9a-f]{64}$/) })
      .strict()
      .nullable()
      .optional(),
    /** The listing's pinned remote MCP tool, when it sells one. */
    mcp: z
      .object({
        connectorId: z.string(),
        endpoint: z.string().url(),
        toolName: z.string(),
        toolSha256: z.string().regex(/^[0-9a-f]{64}$/),
        argsTemplate: z.record(z.string(), z.unknown()),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export type SellerHostJobView = z.infer<typeof sellerHostJobViewSchema>;

export const paymentEvidenceRequestSchema = z.object({ operationId: z.string().min(1).max(128), signature }).strict();

export const leaseGrantSchema = z
  .object({ attemptId: z.uuid(), leaseGeneration: z.number().int().min(1), leaseToken: z.string().min(32), leaseExpiresAt: z.string() })
  .strict();
export type LeaseGrant = z.infer<typeof leaseGrantSchema>;

export const leaseRequestSchema = z.object({ attemptId: z.uuid(), leaseToken: z.string().min(32).max(200) }).strict();

export const completeRequestSchema = z
  .object({
    attemptId: z.uuid(),
    leaseToken: z.string().min(32).max(200),
    envelope: resultEnvelopeSchema,
    /** Artifact bodies as UTF-8 text; the marketplace recomputes size and SHA-256 before validating. */
    artifactBodies: z.array(z.object({ artifactId: z.uuid(), text: z.string().max(1_000_000) }).strict()).max(10),
  })
  .strict();

export const inputRequestSchema = z
  .object({ attemptId: z.uuid(), leaseToken: z.string().min(32).max(200), question: z.string().min(1).max(2_000) })
  .strict();

export const failRequestSchema = z
  .object({ attemptId: z.uuid(), leaseToken: z.string().min(32).max(200), code: z.string().min(1).max(60), uncertain: z.boolean() })
  .strict();

/** Controller → marketplace. Every request carries these signed headers (see controllerSigningMessage). */
export const CONTROLLER_HEADERS = {
  keyId: "x-veilo-controller-key",
  timestamp: "x-veilo-timestamp",
  nonce: "x-veilo-nonce",
  signature: "x-veilo-signature",
} as const;

export const controllerRegistrationSchema = z
  .object({
    controllerKey: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
    keyId: z.string().regex(/^ctl_[A-Za-z0-9_-]{8,64}$/),
    /** Base58 Ed25519 signature by the controller key over controllerRegistrationMessage. */
    proof: z.string().min(64).max(100),
  })
  .strict();

export function controllerRegistrationMessage(workspaceId: string, userId: string, controllerKey: string, keyId: string): string {
  return `veilo:controller-register:v1\n${workspaceId}\n${userId}\n${controllerKey}\n${keyId}`;
}

export const paymentRequestSchema = z
  .object({
    operationId: z.string(),
    jobId: z.uuid(),
    quote: quoteSchema,
    brief: z.string(),
    briefDigest: hex64,
    listing: z.object({ listingId: z.uuid(), slug: z.string(), title: z.string(), sellerName: z.string() }).strict(),
    requestedBy: z.object({ kind: z.enum(["owner", "agent"]), agentId: z.uuid().nullable(), localAgentId: z.string().nullable() }).strict(),
    ownerApprovedAt: z.string().nullable(),
  })
  .strict();
export type PaymentRequest = z.infer<typeof paymentRequestSchema>;

export const controllerDecisionSchema = z
  .object({ decision: z.enum(["accepted", "rejected"]), code: z.string().max(60).nullable(), controllerRef: z.string().max(128).nullable() })
  .strict();

/**
 * `payer` is the one-time wallet that signs the merchant transfer. It is reported once, before or
 * with `paying`, and a receipt only counts when that wallet authorized the transfer.
 */
export const controllerStatusSchema = z
  .object({
    status: z.enum(["paying", "uncertain", "failed_unpaid"]),
    detail: z.string().max(500).nullable(),
    payer: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).nullable().default(null),
    /** Base58 Ed25519 signature by the payer key over payerBindingMessage; required with `payer`. */
    payerProof: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/).nullable().default(null),
  })
  .strict()
  .refine((s) => s.status !== "paying" || s.payer !== null, "paying status must name the payer")
  .refine((s) => (s.payer === null) === (s.payerProof === null), "a payer must come with its proof");

/**
 * Signed by the one-time payer key itself, so a workspace can bind only a payer it controls. The
 * domain prefix keeps this message distinct from any transaction or other Veilo signature.
 */
export function payerBindingMessage(operationId: string, quoteDigest: string, payer: string): string {
  return `veilo:payer-binding:v1\n${operationId}\n${quoteDigest}\n${payer}`;
}

export const agentHireProposalSchema = z
  .object({
    localAgentId: z.string().min(1).max(128),
    listingId: z.uuid(),
    brief: z.string().min(1).max(16_000),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  })
  .strict();
