import { randomUUID } from "node:crypto";
import {
  computeInputDigest,
  computeQuoteDigest,
  completeRequestSchema,
  quoteAmounts,
  remoteOriginProblem,
  resultEnvelopeSchema,
  type QuoteFields,
} from "@veilo/contracts/marketplace";
import type { z } from "zod";
import { sha256Hex, verifyEd25519 } from "./auth";
import { checkTransfer, deriveAta, type Chain } from "./chain";
import type { MarketplaceConfig } from "./config";
import { must, type Db } from "./db";
import { MarketError } from "./errors";

export interface Deps {
  db: Db;
  chain: Chain;
  config: MarketplaceConfig;
  now: () => Date;
}

const JOB_FILES = "job-files";
/**
 * Never hired on their own: Higgsfield's terms forbid a bare pass-through, and the slide renderer
 * and the public publisher act on the seller's own media storage and account.
 */
const WORKFLOW_ONLY_PROVIDERS: ReadonlySet<string> = new Set(["higgsfield", "slides", "zernio_publish"]);

interface CatalogRow {
  listing_id: string;
  listing_version_id: string;
  slug: string;
  runtime_kind: "managed_template" | "remote_endpoint";
  recipient: string;
}

interface VersionRow {
  id: string;
  seller_id: string;
  price_base_units: string | number;
  network: string;
  mint: string;
  decimals: number;
  remote_origin: string | null;
  runtime_version_id: string;
  terms_version: string;
  payout_version_id: string;
}

/** True when a seller origin passes the public-origin rules or the explicit local allowlist. */
export function sellerOriginAllowed(config: MarketplaceConfig, origin: string): boolean {
  return remoteOriginProblem(origin) === null || config.devSellerOrigins.includes(origin.replace(/\/$/, ""));
}

/**
 * One remote seller host serves every listing of its seller under one credential, so the quoted
 * identity names the seller, not the listing; the host must run with this SELLER_HOST_IDENTITY.
 */
export function remoteSellerIdentity(sellerId: string): string {
  return `veilo-remote-${sellerId}`;
}

export function sellerEndpoint(config: MarketplaceConfig, c: CatalogRow, v: VersionRow): { origin: string; identity: string } {
  if (c.runtime_kind === "managed_template") {
    if (!config.managedSellerOrigin) throw new MarketError("NOT_READY", "managed seller host is not configured");
    return { origin: config.managedSellerOrigin, identity: config.managedSellerIdentity };
  }
  if (!v.remote_origin || !sellerOriginAllowed(config, v.remote_origin)) throw new MarketError("SERVICE_NOT_ALLOWED", "seller origin is not allowed");
  return { origin: v.remote_origin.replace(/\/$/, ""), identity: remoteSellerIdentity(v.seller_id) };
}

/**
 * Creates a job and its immutable quote from the published listing version. Price, recipient
 * and token account come from the database, never from the caller.
 */
/** Resolves a wf:<run>:<index> hire key to a real run step, or refuses the hire. */
async function workflowStepFor(deps: Deps, workspaceId: string, key: string, listingVersionId: string): Promise<{ runId: string; index: number }> {
  const m = /^wf:([0-9a-f-]{36}):([0-7])$/.exec(key);
  if (!m) throw new MarketError("INVALID_REQUEST", "workflow hire keys name a run and a step");
  const runId = m[1] as string;
  const index = Number(m[2]);
  const run = (await deps.db.admin.from("workflow_runs").select("id, buyer_workspace_id, status").eq("id", runId).maybeSingle()).data as { buyer_workspace_id: string; status: string } | null;
  if (!run || run.buyer_workspace_id !== workspaceId || !["approved", "running"].includes(run.status)) {
    throw new MarketError("SERVICE_NOT_ALLOWED", "no approved workflow run in this workspace matches the hire key");
  }
  const st = (await deps.db.admin.from("workflow_run_steps").select("tool_kind, tool_id").eq("run_id", runId).eq("step_index", index).maybeSingle()).data as { tool_kind: string; tool_id: string } | null;
  if (!st || st.tool_kind !== "listing" || st.tool_id !== listingVersionId) throw new MarketError("SERVICE_NOT_ALLOWED", "the workflow step does not use this listing version");
  return { runId, index };
}

export async function createHire(
  deps: Deps,
  p: { workspaceId: string; listingId: string; brief: string; idempotencyKey: string; agentId: string | null },
): Promise<{ jobId: string; existing: boolean; quote: QuoteFields & { quoteDigest: string } }> {
  const { db, config } = deps;
  const catalog = must(
    await db.admin.from("catalog_entries").select("listing_id, listing_version_id, slug, runtime_kind, recipient").eq("listing_id", p.listingId).maybeSingle(),
    "listing is not published",
  ) as CatalogRow;
  const version = must(
    await db.admin
      .from("listing_versions")
      .select("id, seller_id, price_base_units, network, mint, decimals, remote_origin, runtime_version_id, terms_version, payout_version_id")
      .eq("id", catalog.listing_version_id)
      .single(),
  ) as VersionRow;
  const payout = must(await db.admin.from("seller_payout_versions").select("address, ata").eq("id", version.payout_version_id).single()) as {
    address: string;
    ata: string;
  };
  if (version.network !== config.network || version.mint !== config.mint) throw new MarketError("WRONG_NETWORK", "listing is not on the configured devnet mint");
  // A workflow step key must name a live run step of this workspace for exactly this listing version.
  const step = p.idempotencyKey.startsWith("wf:") ? await workflowStepFor(deps, p.workspaceId, p.idempotencyKey, catalog.listing_version_id) : null;
  // Providers whose terms forbid a bare paid pass-through are sold only as steps of a workflow.
  const tool = (await db.admin.from("tool_profiles").select("provider").eq("listing_version_id", catalog.listing_version_id).maybeSingle()).data as { provider: string | null } | null;
  if (tool?.provider && WORKFLOW_ONLY_PROVIDERS.has(tool.provider) && step === null) {
    throw new MarketError("SERVICE_NOT_ALLOWED", `${tool.provider} tools are available only as a step of a workflow`);
  }
  if ((await deriveAta(payout.address, version.mint)) !== payout.ata) throw new MarketError("SERVICE_NOT_ALLOWED", "payout token account mismatch");
  const endpoint = sellerEndpoint(config, catalog, version);
  const amounts = quoteAmounts(BigInt(String(version.price_base_units)));
  const jobId = randomUUID();
  const quoteId = randomUUID();
  const fields: QuoteFields = {
    id: quoteId,
    operationId: `mkt_${jobId}`,
    buyerWorkspaceId: p.workspaceId,
    jobId,
    listingVersionId: version.id,
    runtimeVersion: version.runtime_version_id,
    inputDigest: computeInputDigest(p.brief),
    network: version.network,
    genesisHash: config.genesisHash,
    mint: version.mint,
    decimals: version.decimals,
    recipient: payout.address,
    recipientAta: payout.ata,
    sellerOrigin: endpoint.origin,
    sellerIdentity: endpoint.identity,
    baseUnits: amounts.base.toString(),
    feeBps: 0,
    feeUnits: amounts.fee.toString(),
    totalUnits: amounts.total.toString(),
    maxNetworkFeeLamports: config.maxNetworkFeeLamports.toString(),
    termsVersion: version.terms_version,
    expiresAt: new Date(deps.now().getTime() + config.quoteTtlSeconds * 1000).toISOString(),
  };
  const quoteDigest = computeQuoteDigest(fields);
  const r = await db.rpc<{ jobId: string; existing: boolean }>("mk_create_hire", {
    p_workspace: p.workspaceId,
    p_job: jobId,
    p_quote: quoteId,
    p_operation: fields.operationId,
    p_idem: p.idempotencyKey,
    p_agent: p.agentId,
    p_version: version.id,
    p_brief: p.brief,
    p_brief_digest: fields.inputDigest,
    p_fields: fields,
    p_digest: quoteDigest,
  });
  if (r.existing) {
    const q = must(await db.admin.from("jobs").select("current_quote_id").eq("id", r.jobId).single()) as { current_quote_id: string };
    const stored = must(await db.admin.from("quotes").select("fields, quote_digest").eq("id", q.current_quote_id).single()) as {
      fields: QuoteFields;
      quote_digest: string;
    };
    return { jobId: r.jobId, existing: true, quote: { ...stored.fields, quoteDigest: stored.quote_digest } };
  }
  return { jobId, existing: false, quote: { ...fields, quoteDigest } };
}

/**
 * Verifies a claimed settlement on chain against the stored quote. Anyone may submit evidence;
 * only a finalized transfer that matches every quoted field is recorded.
 */
export async function submitEvidence(deps: Deps, operationId: string, signature: string, jobId?: string): Promise<{ status: "settled" | "pending"; receiptId?: string }> {
  const { db } = deps;
  const op = must(
    await db.admin.from("payment_operations").select("job_id, quote_id, status, expected_payer").eq("operation_id", operationId).maybeSingle(),
    "payment operation not found",
  ) as { job_id: string; quote_id: string; status: string; expected_payer: string | null };
  if (jobId && op.job_id !== jobId) throw new MarketError("FORBIDDEN", "operation belongs to another job");
  const quote = must(await db.admin.from("quotes").select("recipient, recipient_ata, mint, network, total_units").eq("id", op.quote_id).single()) as {
    recipient: string;
    recipient_ata: string;
    mint: string;
    network: string;
    total_units: string | number;
  };
  // Identical quotes share recipient and amount; only the payer the buyer's controller reported
  // for this operation can settle it, so another buyer's payment cannot be claimed here.
  if (op.expected_payer === null) return { status: "pending" };
  const tx = await deps.chain.finalizedTransaction(signature);
  const outcome = checkTransfer(tx, {
    signature,
    mint: quote.mint,
    recipient: quote.recipient,
    recipientAta: quote.recipient_ata,
    amount: BigInt(String(quote.total_units)),
    sourceOwner: op.expected_payer,
  });
  if (outcome.status === "pending") return { status: "pending" };
  if (outcome.status === "invalid") throw new MarketError("SERVICE_NOT_ALLOWED", `settlement evidence rejected: ${outcome.reason}`);
  const t = outcome.transfer;
  const r = await db.rpc<{ receiptId: string }>("mk_record_receipt", {
    p_operation: operationId,
    p_network: quote.network,
    p_signature: t.signature,
    p_ix: t.instructionIndex,
    p_mint: t.mint,
    p_source: t.sourceOwner,
    p_ata: t.recipientAta,
    p_amount: t.amount.toString(),
    p_slot: t.slot.toString(),
  });
  return { status: "settled", receiptId: r.receiptId };
}

/**
 * Validates the envelope against the uploaded bodies, stores them, then records completion.
 * Repeating a completion that already committed succeeds without touching its stored artifacts,
 * and objects are removed only once the database shows no completion references them.
 */
export async function completeJob(deps: Deps, jobId: string, body: z.infer<typeof completeRequestSchema>): Promise<void> {
  const env = resultEnvelopeSchema.parse(body.envelope);
  if (env.jobId !== jobId || env.attemptId !== body.attemptId) throw new MarketError("INVALID_REQUEST", "envelope does not match the lease");
  const bodies = new Map(body.artifactBodies.map((a) => [a.artifactId, a.text]));
  if (bodies.size !== env.artifacts.length) throw new MarketError("INVALID_REQUEST", "every artifact needs exactly one body");
  const files = deps.db.admin.storage.from(JOB_FILES);
  const stored: Array<{ artifactId: string; bucket: string; objectKey: string; sha256: string; mimeType: string; bytes: number }> = [];
  try {
    for (const a of env.artifacts) {
      const text = bodies.get(a.artifactId);
      if (text === undefined) throw new MarketError("INVALID_REQUEST", "artifact body missing");
      const bytes = Buffer.from(text, "utf8");
      if (bytes.length !== a.bytes || sha256Hex(bytes) !== a.sha256) throw new MarketError("INVALID_REQUEST", "artifact hash or size does not match its body");
      const objectKey = `jobs/${jobId}/${env.attemptId}/${a.artifactId}`;
      const { error } = await files.upload(objectKey, bytes, { contentType: a.mimeType, upsert: false });
      // An object left by an earlier try of this completion is reused only if it holds the same bytes.
      if (error && !(await storedObjectMatches(deps, objectKey, a.sha256))) throw new MarketError("PROVIDER_UNAVAILABLE", "artifact storage failed");
      stored.push({ artifactId: a.artifactId, bucket: JOB_FILES, objectKey, sha256: a.sha256, mimeType: a.mimeType, bytes: a.bytes });
    }
    await deps.db.rpc("mk_complete", {
      p_job: jobId,
      p_attempt: body.attemptId,
      p_token_hash: sha256Hex(body.leaseToken),
      p_generation: env.leaseGeneration,
      p_status: env.status,
      p_summary: env.summary,
      p_artifacts: stored,
    });
  } catch (error) {
    const committed = await committedCompletion(deps, jobId, body.attemptId);
    // Unknown outcome: keep every object rather than risk deleting a paid result.
    if (committed === null) throw error;
    const sameResult =
      stored.length === env.artifacts.length && committed.artifacts.size === stored.length && stored.every((a) => committed.artifacts.get(a.objectKey) === a.sha256);
    // This attempt's committed artifact rows prove the completion; a result with none relies on the seller host's job lookup.
    if (committed.succeeded && stored.length > 0 && sameResult) return;
    const orphans = stored.map((a) => a.objectKey).filter((k) => !committed.artifacts.has(k));
    if (orphans.length > 0) await files.remove(orphans);
    throw error;
  }
}

async function storedObjectMatches(deps: Deps, objectKey: string, sha256: string): Promise<boolean> {
  const { data, error } = await deps.db.admin.storage.from(JOB_FILES).download(objectKey);
  if (error || !data) return false;
  return sha256Hex(Buffer.from(await data.arrayBuffer())) === sha256;
}

/** Reads what the database committed for an attempt; null when that cannot be determined. */
async function committedCompletion(deps: Deps, jobId: string, attemptId: string): Promise<{ succeeded: boolean; artifacts: Map<string, string> } | null> {
  const [job, rows] = await Promise.all([
    deps.db.admin.from("jobs").select("state").eq("id", jobId).maybeSingle(),
    deps.db.admin.from("artifacts").select("object_key, sha256").eq("job_id", jobId).eq("attempt_id", attemptId).eq("bucket", JOB_FILES),
  ]);
  if (job.error || rows.error || !job.data) return null;
  const artifacts = new Map((rows.data as Array<{ object_key: string; sha256: string }>).map((r) => [r.object_key, r.sha256]));
  return { succeeded: (job.data as { state: string }).state === "succeeded", artifacts };
}

export function payoutProofMessage(p: { userId: string; address: string; network: string; mint: string; issuedAt: string }): string {
  return `veilo:payout-proof:v1\n${p.userId}\n${p.address}\n${p.network}\n${p.mint}\n${p.issuedAt}`;
}

/**
 * Registers a payout version after the seller proves control of the address by signature and
 * the derived token account exists for the configured mint.
 */
export async function addPayout(deps: Deps, userId: string, p: { address: string; issuedAt: string; signature: string }): Promise<string> {
  const { config } = deps;
  const issued = Date.parse(p.issuedAt);
  if (!Number.isFinite(issued) || Math.abs(deps.now().getTime() - issued) > 10 * 60_000) throw new MarketError("INVALID_REQUEST", "proof timestamp outside the allowed window");
  const message = payoutProofMessage({ userId, address: p.address, network: config.network, mint: config.mint, issuedAt: p.issuedAt });
  if (!(await verifyEd25519(p.address, p.signature, message))) throw new MarketError("FORBIDDEN", "payout address proof is invalid");
  const ata = await deriveAta(p.address, config.mint);
  const account = await deps.chain.tokenAccount(ata);
  if (!account || account.mint !== config.mint || account.owner !== p.address) {
    throw new MarketError("NOT_READY", `the payout wallet needs a token account for ${config.mint} at ${ata} before it can receive payments`);
  }
  return deps.db.rpc<string>("mk_add_payout", {
    p_user: userId,
    p_network: config.network,
    p_mint: config.mint,
    p_address: p.address,
    p_ata: ata,
    p_digest: sha256Hex(message),
  });
}

/** Issues a short-lived download link only after RLS confirms the caller is a job participant. */
export async function downloadLink(deps: Deps, accessToken: string, artifactId: string): Promise<{ url: string; expiresAt: string }> {
  const seconds = 60;
  const row = must(
    await deps.db.asUser(accessToken).from("artifacts").select("bucket, object_key, validation_state").eq("id", artifactId).maybeSingle(),
    "artifact not found",
  ) as { bucket: string; object_key: string; validation_state: string };
  if (row.validation_state !== "validated") throw new MarketError("NOT_READY", "artifact is not validated");
  const { data, error } = await deps.db.admin.storage.from(row.bucket).createSignedUrl(row.object_key, seconds, { download: true });
  if (error || !data) throw new MarketError("PROVIDER_UNAVAILABLE", "could not sign the download link");
  return { url: data.signedUrl, expiresAt: new Date(deps.now().getTime() + seconds * 1000).toISOString() };
}
