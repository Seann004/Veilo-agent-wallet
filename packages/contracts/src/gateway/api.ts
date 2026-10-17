import { z } from "zod";
import { GATEWAY_SKUS } from "./catalog";
import { REQUEST_DIGEST_PATTERN } from "./digest";
import { specialistJobInputSchema } from "../marketplace/schemas";

const opaqueId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const digest = z.string().regex(REQUEST_DIGEST_PATTERN, "must be a lowercase hex SHA-256 digest");

/** Inputs per SKU. String limits are coarse; token bounds are enforced separately. */
export const skuInputSchemas = {
  "inference-credit-pack": z.object({ packs: z.literal(1) }).strict(),
  "research-basic": z.object({ query: z.string().min(1).max(500) }).strict(),
  "research-expanded": z.object({ query: z.string().min(1).max(500) }).strict(),
  summarize: z.object({ text: z.string().min(1).max(64_000) }).strict(),
  analyze: z
    .object({ text: z.string().min(1).max(64_000), question: z.string().min(1).max(1_000).optional() })
    .strict(),
  "content-package": z
    .object({
      topic: z.string().min(1).max(500),
      audience: z.string().min(1).max(500),
      channels: z.array(z.string().min(1).max(60)).length(3),
      voice: z.string().min(1).max(300),
      brief: z.string().max(16_000).optional(),
      startDate: z.iso.date().optional(),
    })
    .strict(),
  "specialist-job": specialistJobInputSchema,
} as const;

export const quoteRequestSchema = z
  .object({
    operationId: opaqueId,
    sku: z.enum(GATEWAY_SKUS),
    input: z.unknown(),
    requestDigest: digest,
  })
  .strict();
export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

export const executeRequestSchema = z
  .object({
    operationId: opaqueId,
    requestDigest: digest,
  })
  .strict();
export type ExecuteRequest = z.infer<typeof executeRequestSchema>;

export const usageAuthorizeRequestSchema = z.object({ permit: z.string().min(1).max(4096) }).strict();
export type UsageAuthorizeRequest = z.infer<typeof usageAuthorizeRequestSchema>;

export const usageExecuteRequestSchema = z
  .object({
    operationId: opaqueId,
    reservationId: opaqueId,
    input: z.unknown(),
  })
  .strict();
export type UsageExecuteRequest = z.infer<typeof usageExecuteRequestSchema>;

export const usageReleaseRequestSchema = z.object({ reservationId: opaqueId }).strict();

export const planningRequestSchema = z
  .object({
    taskRef: opaqueId,
    purpose: z.string().min(1).max(200),
    messages: z
      .array(z.object({ role: z.enum(["system", "user"]), content: z.string().min(1).max(16_000) }).strict())
      .min(1)
      .max(8),
    maxOutputTokens: z.number().int().positive().max(1_000).optional(),
  })
  .strict();
export type PlanningRequest = z.infer<typeof planningRequestSchema>;

export interface RecipientBinding {
  network: string;
  asset: string;
  payTo: string;
  merchantAta: string;
  feePayer: string;
  facilitatorUrl: string;
}

export interface QuoteView {
  quoteId: string;
  operationId: string;
  accountId: string;
  sku: string;
  requestDigest: string;
  paymentPath: "x402";
  charge: { amount: string; unit: "usdc_base_units" };
  usageLimits: { maxInputTokens: number | null; maxOutputTokens: number | null };
  recipient: RecipientBinding;
  gateway: { identity: string; origin: string };
  executeUrl: string;
  delivery: string;
  createdAt: string;
  expiresAt: string;
  purchaseState: string | null;
}

export interface CreditBalanceView {
  accountId: string;
  issued: string;
  reserved: string;
  consumed: string;
  usable: string;
  unit: "gateway_microcredits";
  version: string;
  asOf: string;
  label: string;
}

/** HTTP error body. Messages are safe for agents and never include secrets. */
export interface GatewayErrorBody {
  error: { code: string; message: string };
}
