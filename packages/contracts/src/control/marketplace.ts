import { z } from "zod";
import { isAddress } from "@solana/kit";
import { baseUnitString } from "./amounts";

const uuid = z.uuid();
const solanaAddress = z.string().refine((v) => isAddress(v), "must be a base58 Solana address");
const operationId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);

/**
 * Owner approval of one marketplace payment request. Every field must equal the locally stored
 * request; approving a different quote digest, recipient or amount authorizes nothing.
 */
export const marketplaceHireApprovalSchema = z
  .object({
    quoteDigest: z.string().regex(/^[0-9a-f]{64}$/),
    recipient: solanaAddress,
    totalUnits: baseUnitString,
    /** Agent whose allowances pay for the hire. */
    agentId: uuid,
  })
  .strict();

export const marketplaceHireRejectionSchema = z.object({ reason: z.string().trim().min(1).max(300).optional() }).strict();

/** Owner-installed listing grant: the agent may hire this listing at no more than this price. */
export const marketplaceListingGrantSchema = z
  .object({
    listingId: uuid,
    recipient: solanaAddress,
    maxTotalUnits: baseUnitString,
  })
  .strict();

export const marketplaceAllowlistRequestSchema = z.object({ grants: z.array(marketplaceListingGrantSchema).max(50) }).strict();

export const controllerRegistrationRequestSchema = z.object({ workspaceId: uuid, userId: uuid }).strict();

export const marketplaceSearchQuerySchema = z.object({ q: z.string().trim().min(1).max(200) }).strict();

/** Worker request behind the `propose_hire` tool; the agent identity comes from the credential. */
export const workerHireRequestSchema = z
  .object({
    taskId: uuid,
    listingId: uuid,
    brief: z.string().trim().min(1).max(16_000),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  })
  .strict();

export const marketplaceOperationIdSchema = operationId;
