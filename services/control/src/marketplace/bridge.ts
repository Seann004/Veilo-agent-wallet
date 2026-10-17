import { MARKETPLACE_DELEGATION_DEPTH_KEY, SPONSOR_LAMPORTS_PER_PRIVATE_PURCHASE, type ApiErrorCode } from "@veilo/contracts";
import { computeRequestDigest } from "@veilo/contracts/gateway";
import {
  MARKETPLACE_LIMITS,
  SPECIALIST_SKU,
  TEST_TOKEN_LABEL,
  agentHireProposalSchema,
  computeInputDigest,
  paymentRequestSchema,
  verifyQuote,
  type MarketplaceQuote,
  type PaymentRequest,
  type SpecialistJobInput,
} from "@veilo/contracts/marketplace";
import { immediate } from "@veilo/db";
import { big, iso, num, type Ledger } from "../context";
import { ControlError } from "../errors";
import { KeyedLock } from "../integration/locks";
import type { PurchaseOrchestrator } from "../integration/orchestrator";
import { authorizePurchase } from "../ledger/authorize";
import { acceptInbox, enqueueOutbox, markOutboxPublished, writeAudit } from "../ledger/events";
import { cancelUnreleased, decidePurchase, getPurchaseRow, markRecoverable } from "../ledger/purchases";
import { requireAgent, requireWorkspace, type AgentRow } from "../ledger/workspace";
import { deriveAta } from "./addresses";
import { MarketplaceUnreachableError, type MarketplaceClient } from "./client";
import type { ControllerIdentity } from "./controller-identity";
import type { SellerOriginPolicy } from "./origin-policy";
import { LISTING_SERVICE_PREFIX } from "./seller-clients";

export interface ChainIdentity {
  network: string;
  genesisHash: string;
  mint: string;
  decimals: number;
}

export interface MarketplaceBridgeDeps {
  ledger: Ledger;
  client: MarketplaceClient;
  identity: ControllerIdentity;
  orchestrator: PurchaseOrchestrator;
  policy: SellerOriginPolicy;
  chain: ChainIdentity;
  /** Hard ceiling on any one marketplace payment, in test-USDC base units. */
  maxPaymentUnits: bigint;
  /** Time a marketplace quote must still have before the private proof is released. */
  minQuoteRemainingMs?: number;
  log?: (line: string) => void;
}

export type HireState = "received" | "awaiting_approval" | "authorized" | "purchasing" | "uncertain" | "paid" | "failed_unpaid" | "rejected";

/**
 * What the owner sees. evidence_rejected is a paid hire whose evidence the marketplace refused
 * (the report keeps retrying); recoverable is an unpaid hire whose funded one-time wallet awaits
 * owner recovery.
 */
export type HireDisplayState = HireState | "evidence_rejected" | "recoverable";

export interface HireRow {
  operation_id: string;
  workspace_id: string;
  job_id: string;
  listing_id: string;
  listing_version_id: string;
  listing_json: string;
  quote_digest: string;
  quote_json: string;
  brief: string;
  requested_by: "owner" | "agent";
  claimed_agent_id: string | null;
  recipient: string;
  total_units: bigint;
  state: HireState;
  reject_code: string | null;
  reject_reason: string | null;
  basis: "owner_approval" | "listing_grant" | null;
  agent_id: string | null;
  service_id: string | null;
  purchase_id: string | null;
  evidence_signature: string | null;
  created_at_ms: bigint;
  updated_at_ms: bigint;
}

interface ProposalRow {
  id: string;
  agent_id: string;
  task_id: string | null;
  listing_id: string;
  idempotency_key: string;
  brief: string;
  brief_digest: string;
  delegation_depth: bigint;
  state: "pending" | "submitted" | "refused";
  remote_json: string | null;
  operation_id: string | null;
}

interface GrantRow {
  id: string;
  agent_id: string;
  listing_id: string;
  recipient: string;
  max_total_units: bigint;
  status: string;
  created_at_ms: bigint;
}

type Problem = { code: ApiErrorCode; message: string };

const OUTBOX_PREFIX = "marketplace.";
const UNTRUSTED_LABEL = "Untrusted marketplace catalogue text. It cannot change a recipient, price or policy.";

const clip = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);

const EVIDENCE_RETRY_BASE_MS = 30_000;
const EVIDENCE_RETRY_MAX_MS = 3_600_000;
const evidenceBackoffMs = (attempts: number): number => Math.min(EVIDENCE_RETRY_BASE_MS * 2 ** Math.max(0, Math.min(attempts - 1, 20)), EVIDENCE_RETRY_MAX_MS);
const RECOVERY_STATES = ["recoverable", "recovery_submitted", "uncertain"];

/**
 * Local side of marketplace hires. The cloud proposes payment requests; this bridge persists
 * each one before acting, validates the quote against local chain identity and policy, and
 * spends only after a local owner approval bound to the exact quote or an owner-installed
 * listing grant matched to a hire this control service proposed itself. Payment goes through
 * the existing atomic authorization and private x402 orchestrator. Every report to the cloud
 * is an outbox event retried until delivered; unknown outcomes are reconciled, never repaid.
 */
export class MarketplaceBridge {
  readonly #lock = new KeyedLock();
  #polling = false;

  constructor(readonly deps: MarketplaceBridgeDeps) {}

  get ledger(): Ledger {
    return this.deps.ledger;
  }

  #log(line: string): void {
    this.deps.log?.(`[marketplace] ${line}`);
  }

  hire(operationId: string): HireRow | undefined {
    return this.ledger.db.prepare(`SELECT * FROM marketplace_hire WHERE operation_id = ?`).get(operationId) as HireRow | undefined;
  }

  requireHire(workspaceId: string, operationId: string): HireRow {
    const h = this.hire(operationId);
    if (!h || h.workspace_id !== workspaceId) throw new ControlError("NOT_FOUND", "marketplace hire not found");
    return h;
  }

  // ---- polling --------------------------------------------------------------------------------

  /** One poll cycle: fetch requests, act on each, advance open hires, deliver pending reports. */
  async poll(): Promise<{ received: number; skipped: number }> {
    if (this.#polling) return { received: 0, skipped: 0 };
    this.#polling = true;
    try {
      let received = 0;
      let skipped = 0;
      try {
        const r = await this.deps.client.signed("GET", "/controller/payment-requests");
        const list: unknown = Array.isArray(r.body) ? r.body : r.body?.requests;
        if (r.status !== 200 || !Array.isArray(list)) throw new MarketplaceUnreachableError(`payment requests unavailable (HTTP ${r.status})`);
        for (const raw of list as unknown[]) {
          const parsed = paymentRequestSchema.safeParse(raw);
          if (!parsed.success) {
            skipped += 1;
            continue;
          }
          await this.receive(parsed.data);
          received += 1;
        }
      } catch (error) {
        if (!(error instanceof MarketplaceUnreachableError)) throw error;
        this.#log(error.message);
      }
      await this.advanceOpen();
      await this.flush();
      return { received, skipped };
    } finally {
      this.#polling = false;
    }
  }

  /** Persists a payment request (before acting), validates it, and advances it if authorized. */
  async receive(req: PaymentRequest): Promise<HireRow> {
    return this.#lock.run(req.operationId, async () => {
      const stored = this.#persist(req);
      if (stored.state === "received") {
        const problem = await this.#problem(stored);
        immediate(this.ledger.db, () => {
          const cur = this.hire(stored.operation_id) as HireRow;
          if (cur.state !== "received") return;
          if (problem) this.#reject(cur, problem);
          else this.#route(cur);
        });
      }
      await this.#advance(stored.operation_id);
      return this.hire(stored.operation_id) as HireRow;
    });
  }

  #persist(req: PaymentRequest): HireRow {
    return immediate(this.ledger.db, () => {
      const existing = this.hire(req.operationId);
      if (existing) {
        if (existing.quote_digest !== req.quote.quoteDigest || existing.brief !== req.brief || existing.job_id !== req.jobId) {
          writeAudit(this.ledger, {
            workspaceId: existing.workspace_id,
            scope: `marketplace:${existing.operation_id}`,
            actorType: "service",
            actorId: "marketplace",
            action: "marketplace.payment_request",
            policyResult: "denied",
            reasonCode: "IDEMPOTENCY_CONFLICT",
            details: { reason: "operation reused with a different quote, brief or job" },
          });
          if (existing.state === "received" || existing.state === "awaiting_approval") {
            this.#reject(existing, { code: "IDEMPOTENCY_CONFLICT", message: "operation reused with a different quote digest" });
          }
          return this.hire(req.operationId) as HireRow;
        }
        return existing;
      }
      const ws = requireWorkspace(this.ledger);
      const now = this.ledger.now();
      this.ledger.db
        .prepare(
          `INSERT INTO marketplace_hire (operation_id, workspace_id, job_id, listing_id, listing_version_id, listing_json, quote_digest,
             quote_json, brief, requested_by, claimed_agent_id, recipient, total_units, state, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)`,
        )
        .run(
          req.operationId,
          ws.id,
          req.jobId,
          req.listing.listingId,
          req.quote.listingVersionId,
          JSON.stringify(req.listing),
          req.quote.quoteDigest,
          JSON.stringify(req.quote),
          req.brief,
          req.requestedBy.kind,
          req.requestedBy.kind === "agent" ? req.requestedBy.localAgentId : null,
          req.quote.recipient,
          BigInt(req.quote.totalUnits),
          now,
          now,
        );
      writeAudit(this.ledger, {
        workspaceId: ws.id,
        scope: `marketplace:${req.operationId}`,
        actorType: "service",
        actorId: "marketplace",
        action: "marketplace.payment_request",
        policyResult: "not_applicable",
        details: { jobId: req.jobId, listingVersionId: req.quote.listingVersionId, totalUnits: req.quote.totalUnits, cloudOwnerApproved: req.ownerApprovedAt !== null },
      });
      return this.hire(req.operationId) as HireRow;
    });
  }

  quote(h: HireRow): MarketplaceQuote {
    return JSON.parse(h.quote_json) as MarketplaceQuote;
  }

  /** Every local check on the immutable request; rerun before authorization because quotes expire. */
  async #problem(h: HireRow): Promise<Problem | null> {
    const q = this.quote(h);
    const { chain } = this.deps;
    const verified = verifyQuote(q);
    if (verified) return { code: "POLICY_DENIED", message: verified };
    if (q.operationId !== h.operation_id || q.jobId !== h.job_id) return { code: "IDEMPOTENCY_CONFLICT", message: "quote is bound to another operation or job" };
    if (Date.parse(q.expiresAt) <= this.ledger.now()) return { code: "QUOTE_EXPIRED", message: "quote has expired" };
    if (q.network !== chain.network || q.genesisHash !== chain.genesisHash) return { code: "WRONG_NETWORK", message: "quote network differs from this controller's chain" };
    if (q.mint !== chain.mint || q.decimals !== chain.decimals) return { code: "WRONG_MINT", message: "quote mint differs from this controller's mint" };
    if (computeInputDigest(h.brief) !== q.inputDigest) return { code: "IDEMPOTENCY_CONFLICT", message: "brief does not match the quoted input digest" };
    if (BigInt(q.feeUnits) !== 0n || q.feeBps !== 0) return { code: "PRICE_CHANGED", message: "quote carries a nonzero platform fee" };
    if (BigInt(q.totalUnits) <= 0n) return { code: "POLICY_DENIED", message: "free quotes are not paid through the private pool" };
    if (BigInt(q.totalUnits) > this.deps.maxPaymentUnits) return { code: "BUDGET_EXCEEDED", message: "quote exceeds the controller's maximum marketplace payment" };
    const originProblem = this.deps.policy.problem(q.sellerOrigin);
    if (originProblem) return { code: "SERVICE_NOT_ALLOWED", message: originProblem };
    let ata: string;
    try {
      ata = await deriveAta(q.recipient, q.mint);
    } catch {
      return { code: "SERVICE_NOT_ALLOWED", message: "quote recipient is not a valid account" };
    }
    if (ata !== q.recipientAta) return { code: "SERVICE_NOT_ALLOWED", message: "quote recipient token account is not the recipient's associated account" };
    const reg = this.registration();
    if (reg && q.buyerWorkspaceId !== reg.cloud_workspace_id) return { code: "POLICY_DENIED", message: "quote is for another marketplace workspace" };
    return null;
  }

  /** Grant path or owner approval. A cloud approval alone never routes to authorized. */
  #route(h: HireRow): void {
    const grant = this.#grantFor(h);
    if (grant) {
      this.ledger.db.prepare(`UPDATE marketplace_proposal SET operation_id = ?, updated_at_ms = ? WHERE id = ?`).run(h.operation_id, this.ledger.now(), grant.proposal.id);
      this.#setState(h, "authorized", { basis: "listing_grant", agent_id: grant.grant.agent_id });
      writeAudit(this.ledger, {
        workspaceId: h.workspace_id,
        scope: `marketplace:${h.operation_id}`,
        actorType: "system",
        actorId: null,
        action: "marketplace.authorize",
        policyResult: "allowed",
        reasonCode: null,
        details: { basis: "listing_grant", grantId: grant.grant.id, proposalId: grant.proposal.id, agentId: grant.grant.agent_id },
      });
      return;
    }
    this.#setState(h, "awaiting_approval");
  }

  #grantFor(h: HireRow): { grant: GrantRow; proposal: ProposalRow } | null {
    if (h.requested_by !== "agent" || h.claimed_agent_id === null) return null;
    const proposal = this.ledger.db
      .prepare(
        `SELECT * FROM marketplace_proposal WHERE agent_id = ? AND listing_id = ? AND brief_digest = ? AND state = 'submitted'
           AND operation_id IS NULL AND delegation_depth < ? ORDER BY created_at_ms LIMIT 1`,
      )
      .get(h.claimed_agent_id, h.listing_id, computeInputDigest(h.brief), MARKETPLACE_LIMITS.maxDelegationDepth) as ProposalRow | undefined;
    if (!proposal) return null;
    const grant = this.ledger.db
      .prepare(`SELECT * FROM marketplace_listing_grant WHERE agent_id = ? AND listing_id = ? AND status = 'active'`)
      .get(proposal.agent_id, h.listing_id) as GrantRow | undefined;
    if (!grant || grant.recipient !== h.recipient || big(h.total_units) > big(grant.max_total_units)) return null;
    return { grant, proposal };
  }

  #setState(h: HireRow, state: HireState, extra: Partial<Pick<HireRow, "basis" | "agent_id" | "service_id" | "purchase_id" | "evidence_signature" | "reject_code" | "reject_reason">> = {}): void {
    const keys = Object.keys(extra) as Array<keyof typeof extra>;
    const r = this.ledger.db
      .prepare(
        `UPDATE marketplace_hire SET state = ?${keys.map((k) => `, ${k} = ?`).join("")}, updated_at_ms = ? WHERE operation_id = ? AND state = ?`,
      )
      .run(state, ...keys.map((k) => extra[k] ?? null), this.ledger.now(), h.operation_id, h.state);
    if (r.changes !== 1) throw new ControlError("IDEMPOTENCY_CONFLICT", "marketplace hire changed concurrently");
  }

  #report(h: HireRow, topic: "decision" | "status" | "evidence", payload: Record<string, unknown>): void {
    enqueueOutbox(this.ledger, `${OUTBOX_PREFIX}${topic}`, h.operation_id, { operationId: h.operation_id, ...payload });
  }

  /** Rejects a request that holds no purchase; nothing was reserved, so nothing is released. */
  #reject(h: HireRow, p: Problem): void {
    this.#setState(h, "rejected", { reject_code: p.code, reject_reason: p.message.slice(0, 300) });
    this.#report(h, "decision", { decision: "rejected", code: p.code, controllerRef: null });
    writeAudit(this.ledger, {
      workspaceId: h.workspace_id,
      scope: `marketplace:${h.operation_id}`,
      actorType: "system",
      actorId: null,
      action: "marketplace.reject",
      policyResult: "denied",
      reasonCode: p.code,
      details: { reason: p.message },
    });
  }

  // ---- owner actions --------------------------------------------------------------------------

  /** Local owner approval bound to the exact operation, quote digest, recipient and total. */
  async approve(
    owner: { workspaceId: string; ownerPubkey: string },
    operationId: string,
    body: { quoteDigest: string; recipient: string; totalUnits: string; agentId: string },
  ): Promise<HireRow> {
    return this.#lock.run(operationId, async () => {
      const h = this.requireHire(owner.workspaceId, operationId);
      if (h.state !== "awaiting_approval") throw new ControlError("IDEMPOTENCY_CONFLICT", `hire is ${h.state}, not awaiting local approval`);
      if (body.quoteDigest !== h.quote_digest || body.recipient !== h.recipient || BigInt(body.totalUnits) !== big(h.total_units)) {
        immediate(this.ledger.db, () =>
          writeAudit(this.ledger, {
            workspaceId: h.workspace_id,
            scope: `marketplace:${h.operation_id}`,
            actorType: "owner",
            actorId: owner.ownerPubkey,
            action: "marketplace.approve",
            policyResult: "denied",
            reasonCode: "IDEMPOTENCY_CONFLICT",
            details: { reason: "approval does not match the stored quote" },
          }),
        );
        throw new ControlError("IDEMPOTENCY_CONFLICT", "approval does not match this request's quote digest, recipient and total");
      }
      const problem = await this.#problem(h);
      immediate(this.ledger.db, () => {
        const cur = this.hire(operationId) as HireRow;
        if (cur.state !== "awaiting_approval") throw new ControlError("IDEMPOTENCY_CONFLICT", `hire is ${cur.state}`);
        if (problem) {
          this.#reject(cur, problem);
          return;
        }
        const agent = requireAgent(this.ledger, owner.workspaceId, body.agentId);
        if (agent.status !== "active") throw new ControlError("ACCOUNT_STOPPED", `agent is ${agent.status}`);
        this.ledger.db
          .prepare(
            `INSERT INTO marketplace_hire_approval (operation_id, quote_digest, recipient, total_units, agent_id, owner_pubkey, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(operationId, body.quoteDigest, body.recipient, BigInt(body.totalUnits), body.agentId, owner.ownerPubkey, this.ledger.now());
        this.#setState(cur, "authorized", { basis: "owner_approval", agent_id: body.agentId });
        writeAudit(this.ledger, {
          workspaceId: cur.workspace_id,
          scope: `marketplace:${operationId}`,
          actorType: "owner",
          actorId: owner.ownerPubkey,
          action: "marketplace.approve",
          policyResult: "allowed",
          details: { agentId: body.agentId, totalUnits: body.totalUnits },
        });
      });
      if (problem) throw new ControlError(problem.code, problem.message);
      await this.#advance(operationId);
      return this.hire(operationId) as HireRow;
    });
  }

  async reject(owner: { workspaceId: string; ownerPubkey: string }, operationId: string, reason?: string): Promise<HireRow> {
    return this.#lock.run(operationId, async () => {
      immediate(this.ledger.db, () => {
        const h = this.requireHire(owner.workspaceId, operationId);
        if (h.state !== "received" && h.state !== "awaiting_approval") throw new ControlError("IDEMPOTENCY_CONFLICT", `hire is ${h.state}; use pause or revoke to stop a purchase in progress`);
        this.#reject(h, { code: "POLICY_DENIED", message: reason ?? "rejected by the owner" });
      });
      return this.hire(operationId) as HireRow;
    });
  }

  setAllowlist(owner: { workspaceId: string; ownerPubkey: string }, agentId: string, grants: Array<{ listingId: string; recipient: string; maxTotalUnits: string }>): GrantRow[] {
    return immediate(this.ledger.db, () => {
      const agent = requireAgent(this.ledger, owner.workspaceId, agentId);
      if (agent.status === "revoked" || agent.status === "archived") throw new ControlError("ACCOUNT_STOPPED", `agent is ${agent.status}`);
      if (new Set(grants.map((g) => g.listingId)).size !== grants.length) throw new ControlError("INVALID_REQUEST", "each listing may appear once");
      const now = this.ledger.now();
      this.ledger.db
        .prepare(`UPDATE marketplace_listing_grant SET status = 'removed', removed_at_ms = ? WHERE agent_id = ? AND status = 'active'`)
        .run(now, agentId);
      for (const g of grants) {
        const max = BigInt(g.maxTotalUnits);
        if (max <= 0n) throw new ControlError("INVALID_REQUEST", "maxTotalUnits must be positive");
        if (max > this.deps.maxPaymentUnits) throw new ControlError("BUDGET_EXCEEDED", "grant exceeds the controller's maximum marketplace payment");
        this.ledger.db
          .prepare(
            `INSERT INTO marketplace_listing_grant (id, workspace_id, agent_id, listing_id, recipient, max_total_units, status, created_by, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          )
          .run(this.ledger.newId(), owner.workspaceId, agentId, g.listingId, g.recipient, max, owner.ownerPubkey, now);
      }
      writeAudit(this.ledger, {
        workspaceId: owner.workspaceId,
        scope: `agent:${agentId}`,
        actorType: "owner",
        actorId: owner.ownerPubkey,
        action: "marketplace.allowlist",
        policyResult: "allowed",
        details: { grants: grants.map((g) => ({ listingId: g.listingId, recipient: g.recipient, maxTotalUnits: g.maxTotalUnits })) },
      });
      return this.grants(agentId);
    });
  }

  grants(agentId: string): GrantRow[] {
    return this.ledger.db.prepare(`SELECT * FROM marketplace_listing_grant WHERE agent_id = ? AND status = 'active' ORDER BY created_at_ms`).all(agentId) as GrantRow[];
  }

  grantView(g: GrantRow): Record<string, unknown> {
    return { id: g.id, agentId: g.agent_id, listingId: g.listing_id, recipient: g.recipient, maxTotalUnits: big(g.max_total_units).toString(), createdAt: iso(g.created_at_ms) };
  }

  registration(): { key_id: string; controller_key: string; cloud_workspace_id: string; cloud_user_id: string; updated_at_ms: bigint } | undefined {
    return this.ledger.db.prepare(`SELECT * FROM marketplace_controller WHERE key_id = ?`).get(this.deps.identity.keyId) as
      | { key_id: string; controller_key: string; cloud_workspace_id: string; cloud_user_id: string; updated_at_ms: bigint }
      | undefined;
  }

  /** Signed registration proof for the owner's dashboard to submit with their marketplace session. */
  register(owner: { workspaceId: string; ownerPubkey: string }, cloudWorkspaceId: string, cloudUserId: string): { controllerKey: string; keyId: string; proof: string } {
    const reg = this.deps.identity.registration(cloudWorkspaceId, cloudUserId);
    immediate(this.ledger.db, () => {
      const now = this.ledger.now();
      this.ledger.db
        .prepare(
          `INSERT INTO marketplace_controller (key_id, controller_key, cloud_workspace_id, cloud_user_id, registered_by, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (key_id) DO UPDATE SET cloud_workspace_id = excluded.cloud_workspace_id, cloud_user_id = excluded.cloud_user_id,
             registered_by = excluded.registered_by, updated_at_ms = excluded.updated_at_ms`,
        )
        .run(reg.keyId, reg.controllerKey, cloudWorkspaceId, cloudUserId, owner.ownerPubkey, now, now);
      writeAudit(this.ledger, {
        workspaceId: owner.workspaceId,
        scope: "marketplace:controller",
        actorType: "owner",
        actorId: owner.ownerPubkey,
        action: "marketplace.controller_register",
        policyResult: "allowed",
        details: { keyId: reg.keyId, cloudWorkspaceId },
      });
    });
    return reg;
  }

  /** Owner-visible state and the problem behind it; derived, so the stored hire state is unchanged. */
  outcome(h: HireRow): { state: HireDisplayState; problem: { code: string; reason: string | null; attempts?: number; nextRetryAt?: string | null } | null } {
    if (h.state === "paid") {
      const refusal = this.#evidenceRefusal(h.operation_id);
      if (refusal) {
        return {
          state: "evidence_rejected",
          problem: { code: refusal.code, reason: refusal.reason, attempts: refusal.attempts, nextRetryAt: refusal.retryAtMs > 0 ? iso(BigInt(refusal.retryAtMs)) : null },
        };
      }
    }
    if (h.state === "failed_unpaid" && h.purchase_id !== null) {
      const p = getPurchaseRow(this.ledger, h.purchase_id);
      if (RECOVERY_STATES.includes(p.recovery_state)) {
        const code = this.ledger.db
          .prepare(`SELECT reason_code FROM audit_event WHERE scope = ? AND action = 'marketplace.recoverable' ORDER BY seq DESC LIMIT 1`)
          .pluck()
          .get(`marketplace:${h.operation_id}`) as string | null | undefined;
        return { state: "recoverable", problem: { code: code ?? "RECOVERY_REQUIRED", reason: p.state_reason ?? null } };
      }
    }
    return { state: h.state, problem: null };
  }

  /** Hires the owner must act on or should see: pending decisions, refused evidence, recoverable funds. */
  needsOwner(h: HireRow): boolean {
    if (h.state === "received" || h.state === "awaiting_approval") return true;
    const state = this.outcome(h).state;
    return state === "evidence_rejected" || state === "recoverable";
  }

  hireView(h: HireRow): Record<string, unknown> {
    const q = this.quote(h);
    const outcome = this.outcome(h);
    const listing = JSON.parse(h.listing_json) as Record<string, unknown>;
    const approval = this.ledger.db.prepare(`SELECT agent_id, owner_pubkey, created_at_ms FROM marketplace_hire_approval WHERE operation_id = ?`).get(h.operation_id) as
      | { agent_id: string; owner_pubkey: string; created_at_ms: bigint }
      | undefined;
    return {
      operationId: h.operation_id,
      jobId: h.job_id,
      state: outcome.state,
      recordState: h.state,
      problem: outcome.problem,
      listing: { ...listing, untrusted: true },
      requestedBy: { kind: h.requested_by, claimedAgentId: h.claimed_agent_id },
      quote: {
        quoteDigest: h.quote_digest,
        listingVersionId: q.listingVersionId,
        recipient: q.recipient,
        recipientAta: q.recipientAta,
        sellerOrigin: q.sellerOrigin,
        sellerIdentity: q.sellerIdentity,
        network: q.network,
        mint: q.mint,
        baseUnits: q.baseUnits,
        feeUnits: q.feeUnits,
        totalUnits: q.totalUnits,
        expiresAt: q.expiresAt,
        label: TEST_TOKEN_LABEL,
      },
      brief: h.brief,
      basis: h.basis,
      agentId: h.agent_id,
      approval: approval ? { agentId: approval.agent_id, approvedBy: approval.owner_pubkey, approvedAt: iso(approval.created_at_ms) } : null,
      purchaseId: h.purchase_id,
      rejected: h.reject_code ? { code: h.reject_code, reason: h.reject_reason } : null,
      evidenceSignature: h.evidence_signature,
      createdAt: iso(h.created_at_ms),
      updatedAt: iso(h.updated_at_ms),
    };
  }

  list(workspaceId: string, states: readonly HireState[] | null): HireRow[] {
    const rows = this.ledger.db.prepare(`SELECT * FROM marketplace_hire WHERE workspace_id = ? ORDER BY created_at_ms DESC LIMIT 200`).all(workspaceId) as HireRow[];
    return states ? rows.filter((r) => states.includes(r.state)) : rows;
  }

  // ---- authorization and purchase ---------------------------------------------------------------

  /** Advances every hire that is authorized or has a purchase in flight. */
  async advanceOpen(): Promise<void> {
    const ids = this.ledger.db
      .prepare(`SELECT operation_id FROM marketplace_hire WHERE state IN ('authorized', 'purchasing', 'uncertain') ORDER BY created_at_ms`)
      .pluck()
      .all() as string[];
    for (const id of ids) await this.#lock.run(id, () => this.#advance(id));
  }

  async #advance(operationId: string): Promise<void> {
    let h = this.hire(operationId) as HireRow;
    if (h.state === "authorized") {
      await this.#authorize(h);
      h = this.hire(operationId) as HireRow;
    }
    if ((h.state === "purchasing" || h.state === "uncertain") && h.purchase_id !== null) {
      const driven = await this.deps.orchestrator.drive(h.purchase_id);
      this.#sync(h, driven.execution.blocked?.code ?? null);
    }
  }

  #ensureListingService(h: HireRow, q: MarketplaceQuote): string {
    const key = `${LISTING_SERVICE_PREFIX}${q.listingVersionId}`;
    const now = this.ledger.now();
    const existing = this.ledger.db.prepare(`SELECT * FROM approved_service WHERE workspace_id = ? AND service_key = ?`).get(h.workspace_id, key) as
      | { id: string; origin: string; gateway_identity: string | null; recipient: string | null; recipient_ata: string | null; network: string; mint: string; status: string }
      | undefined;
    let serviceId: string;
    if (existing) {
      if (
        existing.origin !== q.sellerOrigin ||
        existing.gateway_identity !== q.sellerIdentity ||
        existing.recipient !== q.recipient ||
        existing.recipient_ata !== q.recipientAta ||
        existing.network !== q.network ||
        existing.mint !== q.mint
      ) {
        throw new ControlError("SERVICE_NOT_ALLOWED", "listing version binding differs from an earlier approved binding");
      }
      if (existing.status !== "approved") throw new ControlError("SERVICE_NOT_ALLOWED", "listing service binding is disabled");
      serviceId = existing.id;
    } else {
      serviceId = this.ledger.newId();
      this.ledger.db
        .prepare(
          `INSERT INTO approved_service (id, workspace_id, service_key, origin, gateway_identity, recipient, recipient_ata, network, mint,
             status, description, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)`,
        )
        .run(serviceId, h.workspace_id, key, q.sellerOrigin, q.sellerIdentity, q.recipient, q.recipientAta, q.network, q.mint, "Marketplace listing version (seller host)", now, now);
    }
    const price = BigInt(q.totalUnits);
    const sku = this.ledger.db
      .prepare(`SELECT price_usdc, max_fee_usdc, enabled FROM service_sku WHERE service_id = ? AND sku = ? AND payment_path = 'private_x402'`)
      .get(serviceId, SPECIALIST_SKU) as { price_usdc: bigint; max_fee_usdc: bigint; enabled: bigint } | undefined;
    if (sku) {
      if (big(sku.price_usdc) !== price || big(sku.max_fee_usdc) !== 0n) throw new ControlError("PRICE_CHANGED", "listing version price differs from its earlier binding");
      if (sku.enabled !== 1n) throw new ControlError("SERVICE_NOT_ALLOWED", "listing SKU is disabled");
    } else {
      this.ledger.db
        .prepare(
          `INSERT INTO service_sku (id, service_id, sku, payment_path, price_usdc, max_fee_usdc, usage_units, sponsor_lamports)
           VALUES (?, ?, ?, 'private_x402', ?, 0, 0, ?)`,
        )
        .run(this.ledger.newId(), serviceId, SPECIALIST_SKU, price, SPONSOR_LAMPORTS_PER_PRIVATE_PURCHASE);
    }
    return serviceId;
  }

  async #authorize(h: HireRow): Promise<void> {
    // A purchase committed before a crash is adopted as-is; it must never be orphaned by a
    // later re-check, or the background sweep would drive it without this hire.
    const prior = this.ledger.db
      .prepare(`SELECT id, operation_id FROM purchase WHERE agent_id = ? AND idempotency_key = ?`)
      .get(h.agent_id, `mkt:${h.operation_id}`) as { id: string; operation_id: string } | undefined;
    if (prior) {
      immediate(this.ledger.db, () => {
        const cur = this.hire(h.operation_id) as HireRow;
        if (cur.state !== "authorized") return;
        const serviceId = this.ledger.db.prepare(`SELECT service_id FROM purchase WHERE id = ?`).pluck().get(prior.id) as string;
        this.#setState(cur, "purchasing", { service_id: serviceId, purchase_id: prior.id });
        this.#report(cur, "decision", { decision: "accepted", code: null, controllerRef: prior.operation_id });
      });
      return;
    }
    const problem = await this.#problem(h);
    if (problem) {
      immediate(this.ledger.db, () => {
        const cur = this.hire(h.operation_id) as HireRow;
        if (cur.state === "authorized" && cur.purchase_id === null) this.#reject(cur, problem);
      });
      return;
    }
    const q = this.quote(h);
    const input: SpecialistJobInput = { jobId: h.job_id, listingVersionId: q.listingVersionId, quoteDigest: h.quote_digest, brief: h.brief };
    // A granted hire, or a workflow step an agent proposed from a task, spends from that task, so
    // its budget, deadline and purchase count bound it.
    const taskId =
      ((h.basis === "listing_grant"
        ? this.ledger.db.prepare(`SELECT task_id FROM marketplace_proposal WHERE operation_id = ?`).pluck().get(h.operation_id)
        : this.ledger.db
            .prepare(`SELECT r.task_id FROM workflow_run_step s JOIN workflow_run r ON r.id = s.run_id WHERE s.operation_id = ?`)
            .pluck()
            .get(h.operation_id)) as string | null | undefined) ?? undefined;
    let purchase;
    let serviceId: string;
    try {
      serviceId = immediate(this.ledger.db, () => this.#ensureListingService(h, q));
      purchase = authorizePurchase(this.ledger, {
        workspaceId: h.workspace_id,
        agentId: h.agent_id as string,
        idempotencyKey: `mkt:${h.operation_id}`,
        serviceId,
        sku: SPECIALIST_SKU,
        paymentPath: "private_x402",
        requestDigest: computeRequestDigest(SPECIALIST_SKU, input),
        taskId,
        proposedByTask: taskId !== undefined,
        rationale: `Marketplace hire ${h.operation_id} (${h.basis === "owner_approval" ? "local owner approval" : "owner listing grant"})`,
      }).purchase;
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      immediate(this.ledger.db, () => {
        const cur = this.hire(h.operation_id) as HireRow;
        if (cur.state === "authorized" && cur.purchase_id === null) this.#reject(cur, { code: error.code, message: error.message });
      });
      return;
    }
    this.deps.orchestrator.storeInput(purchase, input as unknown as Record<string, unknown>);
    immediate(this.ledger.db, () => {
      const cur = this.hire(h.operation_id) as HireRow;
      if (cur.state !== "authorized") return;
      this.#setState(cur, "purchasing", { service_id: serviceId, purchase_id: purchase.id });
      this.#report(cur, "decision", { decision: "accepted", code: null, controllerRef: purchase.operation_id });
    });
    if (purchase.authorization_state === "awaiting_approval" && h.basis === "owner_approval") {
      // The owner already approved this exact operation locally; the purchase-level approval
      // the agent tier asks for is the same decision.
      const approval = this.ledger.db.prepare(`SELECT owner_pubkey FROM marketplace_hire_approval WHERE operation_id = ?`).pluck().get(h.operation_id) as string;
      decidePurchase(this.ledger, purchase.id, "approve", approval);
    }
  }

  /** Orchestrator hook: the fresh payer exists locally; nothing has been released on chain. */
  payerKnown(purchaseId: string, payer: string): void {
    this.ledger.db
      .prepare(`UPDATE marketplace_hire SET payer = ?, updated_at_ms = ? WHERE purchase_id = ? AND payer IS NULL`)
      .run(payer, this.ledger.now(), purchaseId);
  }

  #payingQueued(operationId: string): boolean {
    const n = this.ledger.db
      .prepare(`SELECT count(*) FROM outbox WHERE topic = 'marketplace.status' AND aggregate_id = ? AND json_extract(payload_json, '$.status') = 'paying'`)
      .pluck()
      .get(operationId);
    return num(n) > 0;
  }

  #refusePayer(operationId: string, message: string, code: ApiErrorCode = "POLICY_DENIED"): { outcome: "refuse"; reason: string } {
    immediate(this.ledger.db, () => {
      const cur = this.hire(operationId) as HireRow;
      if (cur.state === "purchasing" || cur.state === "uncertain") this.#reject(cur, { code, message });
    });
    return { outcome: "refuse", reason: message };
  }

  get #minQuoteRemainingMs(): number {
    return this.deps.minQuoteRemainingMs ?? MARKETPLACE_LIMITS.minQuoteRemainingSeconds * 1000;
  }

  /**
   * Orchestrator gate before the proof is released. The payer key proves possession over the
   * binding message, the marketplace must acknowledge that payer, and only then may the proof go
   * out. An unknown outcome keeps waiting and re-sends the same report; a definitive refusal
   * cancels the unreleased funding, so nothing reaches the chain for an unbound payer.
   */
  async beforeRelease(purchaseId: string): Promise<{ outcome: "ok" | "wait" | "refuse"; reason?: string }> {
    type Row = HireRow & { payer: string | null; payer_state: "none" | "bound" | "refused" };
    const read = () => this.ledger.db.prepare(`SELECT * FROM marketplace_hire WHERE purchase_id = ?`).get(purchaseId) as Row | undefined;
    let h = read();
    if (!h) return { outcome: "ok" };
    // The seller host refuses an expired quote, so a withdrawal that finishes after expiry would
    // leave the funds in the one-time wallet. Release only with enough time left to pay.
    const remainingMs = Date.parse(this.quote(h).expiresAt) - this.ledger.now();
    if (remainingMs < this.#minQuoteRemainingMs) {
      return this.#refusePayer(
        h.operation_id,
        `the marketplace quote has ${Math.max(0, Math.floor(remainingMs / 1000))} s left, under the ${Math.ceil(this.#minQuoteRemainingMs / 1000)} s needed to release the private proof`,
        "QUOTE_EXPIRED",
      );
    }
    if (h.payer_state === "none") {
      if (!this.#payingQueued(h.operation_id)) {
        const ex = this.deps.orchestrator.execution(purchaseId);
        const funding = this.deps.orchestrator.deps.funding;
        if (!ex?.funding_ref || !ex.merchant_payer) return { outcome: "wait", reason: "the one-time payer is not known yet" };
        if (!funding.signPayerBinding) return { outcome: "wait", reason: "the funding provider cannot prove payer-key possession" };
        const signed = await funding.signPayerBinding({ purchaseId, fundingRef: ex.funding_ref, operationId: h.operation_id, quoteDigest: h.quote_digest });
        if (signed.status === "not_ready") return { outcome: "wait", reason: `payer binding not signed: ${signed.reason}` };
        if (signed.status === "refused") return this.#refusePayer(h.operation_id, `the wallet refused to sign the payer binding: ${signed.reason}`);
        if (signed.payer !== ex.merchant_payer || (h.payer !== null && signed.payer !== h.payer)) {
          return this.#refusePayer(h.operation_id, "the signed payer differs from the funding attempt's payer");
        }
        immediate(this.ledger.db, () => {
          const cur = read() as Row;
          if (cur.payer === null) this.payerKnown(purchaseId, signed.payer);
          if (!this.#payingQueued(cur.operation_id)) this.#report(cur, "status", { status: "paying", detail: null, payer: signed.payer, payerProof: signed.proof });
        });
      }
      await this.flush(h.operation_id);
      h = read() as Row;
    }
    if (h.payer_state === "bound") return { outcome: "ok" };
    if (h.payer_state === "refused") return this.#refusePayer(h.operation_id, "the marketplace refused to bind this operation's payer");
    return { outcome: "wait", reason: "waiting for the marketplace to acknowledge the payer" };
  }

  /**
   * Orchestrator gate after funding finalized and before any merchant authority. If the
   * marketplace quote has expired the seller cannot be paid under it, so nothing is signed: the
   * funded purchase becomes recoverable by the owner and the hire closes unpaid.
   */
  beforeMerchant(purchaseId: string): { outcome: "ok" } | { outcome: "stop"; code: string; reason: string } {
    const h = this.ledger.db.prepare(`SELECT * FROM marketplace_hire WHERE purchase_id = ?`).get(purchaseId) as HireRow | undefined;
    if (!h || Date.parse(this.quote(h).expiresAt) > this.ledger.now()) return { outcome: "ok" };
    const reason = "The marketplace quote expired after private funding, so the seller was not paid. The one-time wallet holds the funds for owner recovery.";
    immediate(this.ledger.db, () => {
      markRecoverable(this.ledger, purchaseId, reason);
      const cur = this.hire(h.operation_id) as HireRow;
      if (cur.state !== "purchasing" && cur.state !== "uncertain") return;
      this.#setState(cur, "failed_unpaid");
      this.#report(cur, "status", { status: "failed_unpaid", detail: "marketplace quote expired after funding; nothing was paid" });
      writeAudit(this.ledger, {
        workspaceId: cur.workspace_id,
        scope: `marketplace:${cur.operation_id}`,
        actorType: "system",
        actorId: null,
        action: "marketplace.recoverable",
        policyResult: "denied",
        reasonCode: "QUOTE_EXPIRED",
        details: { purchaseId, reason },
      });
    });
    return { outcome: "stop", code: "QUOTE_EXPIRED", reason };
  }

  /** Maps the purchase legs onto the hire and queues the matching report once per transition. */
  #sync(h: HireRow, blocked: string | null): void {
    immediate(this.ledger.db, () => {
      const cur = this.hire(h.operation_id) as HireRow;
      if (cur.purchase_id === null || (cur.state !== "purchasing" && cur.state !== "uncertain")) return;
      const p = getPurchaseRow(this.ledger, cur.purchase_id);
      if (p.merchant_state === "finalized") {
        const signature = this.ledger.db
          .prepare(`SELECT signature FROM chain_attempt WHERE purchase_id = ? AND leg = 'merchant' AND observed_commitment = 'finalized' AND signature IS NOT NULL`)
          .pluck()
          .get(p.id) as string | undefined;
        if (!signature) return;
        this.#setState(cur, "paid", { evidence_signature: signature });
        this.#report(cur, "evidence", { signature });
        return;
      }
      if (p.authorization_state === "reserved" && p.funding_state === "not_started" && Date.parse(this.quote(cur).expiresAt) <= this.ledger.now()) {
        // The marketplace quote lapsed before any authority was released: free the reservation.
        cancelUnreleased(this.ledger, p, "rejected");
        this.#setState(cur, "failed_unpaid");
        this.#report(cur, "status", { status: "failed_unpaid", detail: "quote expired before payment started" });
        return;
      }
      const merchantUnpaid = ["not_started", "abandoned", "expired_unsettled"].includes(p.merchant_state);
      const nothingInFlight =
        p.authorization_state === "rejected" ||
        p.funding_state === "expired_unsettled" ||
        p.funding_state === "abandoned" ||
        p.merchant_state === "expired_unsettled" ||
        p.merchant_state === "abandoned";
      if (merchantUnpaid && nothingInFlight) {
        this.#setState(cur, "failed_unpaid");
        this.#report(cur, "status", { status: "failed_unpaid", detail: p.state_reason ?? null });
        return;
      }
      const uncertain = blocked === "SETTLEMENT_UNCERTAIN" || [p.funding_state, p.merchant_state, p.fulfilment_state].includes("uncertain");
      if (uncertain && cur.state === "purchasing") {
        this.#setState(cur, "uncertain");
        this.#report(cur, "status", { status: "uncertain", detail: "settlement outcome pending; the same operation is being reconciled" });
      }
    });
  }

  // ---- outbound reports -------------------------------------------------------------------------

  #endpoint(topic: string, operationId: string): string {
    const op = encodeURIComponent(operationId);
    switch (topic) {
      case "marketplace.decision":
        return `/controller/payment-requests/${op}/decision`;
      case "marketplace.status":
        return `/controller/payment-requests/${op}/status`;
      case "marketplace.evidence":
        return `/controller/payments/${op}/evidence`;
      default:
        return "/controller/hires";
    }
  }

  /**
   * Delivers pending marketplace reports in order, per operation. A report whose reply is lost
   * stays pending and is re-sent with the same body; the inbox records each delivery once.
   */
  async flush(aggregateId?: string): Promise<{ delivered: number; pending: number }> {
    const rows = this.ledger.db
      .prepare(
        `SELECT seq, event_id, topic, aggregate_id, payload_json, attempts FROM outbox
         WHERE published_at_ms IS NULL AND topic LIKE 'marketplace.%' AND (? IS NULL OR aggregate_id = ?) ORDER BY seq`,
      )
      .all(aggregateId ?? null, aggregateId ?? null) as Array<{ seq: bigint; event_id: string; topic: string; aggregate_id: string; payload_json: string; attempts: bigint }>;
    const stalled = new Set<string>();
    let delivered = 0;
    for (const row of rows) {
      if (stalled.has(row.aggregate_id)) continue;
      if (row.topic === "marketplace.evidence" && num(row.attempts) > 0) {
        const retryAt = this.#evidenceRefusal(row.aggregate_id)?.retryAtMs ?? 0;
        if (this.ledger.now() < retryAt) {
          stalled.add(row.aggregate_id);
          continue;
        }
      }
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      let body: Record<string, unknown>;
      if (row.topic === "marketplace.proposal") {
        const p = this.ledger.db.prepare(`SELECT * FROM marketplace_proposal WHERE id = ?`).get(row.aggregate_id) as ProposalRow | undefined;
        if (!p) {
          markOutboxPublished(this.ledger, row.event_id);
          continue;
        }
        body = { localAgentId: p.agent_id, listingId: p.listing_id, brief: p.brief, idempotencyKey: p.idempotency_key };
      } else if (row.topic === "marketplace.decision") {
        body = { decision: payload.decision, code: payload.code ?? null, controllerRef: payload.controllerRef ?? null };
      } else if (row.topic === "marketplace.status") {
        body = { status: payload.status, detail: payload.detail ?? null, payer: payload.payer ?? null, payerProof: payload.payerProof ?? null };
      } else {
        body = { operationId: payload.operationId, signature: payload.signature };
      }
      const ok = await this.#deliver(row, body);
      if (ok) delivered += 1;
      else stalled.add(row.aggregate_id);
    }
    return { delivered, pending: rows.length - delivered };
  }

  async #deliver(row: { event_id: string; topic: string; aggregate_id: string }, body: Record<string, unknown>): Promise<boolean> {
    let r;
    try {
      r = await this.deps.client.signed("POST", this.#endpoint(row.topic, row.aggregate_id), body);
    } catch (error) {
      if (error instanceof MarketplaceUnreachableError) return false;
      throw error;
    }
    if (r.status >= 500 || r.status === 408 || r.status === 429) return false;
    // A 401 on an operation report is a signing-window problem (clock skew, nonce), not a refusal
    // of the operation; the retry is signed again with a fresh nonce and timestamp.
    if (r.status === 401 && row.topic !== "marketplace.proposal") return false;
    if (row.topic === "marketplace.evidence") return this.#evidenceReply(row, r);
    const ok = r.status >= 200 && r.status < 300;
    const payerReport = row.topic === "marketplace.status" && body.status === "paying" && typeof body.payer === "string";
    // Only a definite payer conflict or invalid proof (403, 409 including INVALID_TRANSITION)
    // refuses the payer; anything else keeps the proof unreleased and re-sends the same report.
    if (payerReport && !ok && r.status !== 403 && r.status !== 409) {
      this.#log(`payer report for ${row.aggregate_id} not acknowledged (HTTP ${r.status}); retrying`);
      return false;
    }
    immediate(this.ledger.db, () => {
      const fresh = acceptInbox(this.ledger, "marketplace", `mkt:${row.event_id}`, row.topic, { aggregateId: row.aggregate_id, topic: row.topic });
      if (fresh && row.topic === "marketplace.proposal") this.#applyProposalReply(row.aggregate_id, r.status, r.body);
      if (payerReport) {
        this.ledger.db
          .prepare(`UPDATE marketplace_hire SET payer_state = ?, updated_at_ms = ? WHERE operation_id = ? AND payer = ? AND payer_state = 'none'`)
          .run(ok ? "bound" : "refused", this.ledger.now(), row.aggregate_id, body.payer);
      }
      if (fresh && r.status >= 400) {
        writeAudit(this.ledger, {
          workspaceId: requireWorkspace(this.ledger).id,
          scope: `marketplace:${row.aggregate_id}`,
          actorType: "service",
          actorId: "marketplace",
          action: `${row.topic}.refused`,
          policyResult: "not_applicable",
          reasonCode: null,
          details: { status: r.status, code: clip(r.body?.error?.code, 60) },
        });
      }
      markOutboxPublished(this.ledger, row.event_id);
    });
    return true;
  }

  /**
   * Evidence is reported only after the merchant transfer finalized, so a refusal never closes
   * the report: it stays queued, is retried with backoff and shows as evidence_rejected.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #evidenceReply(row: { event_id: string; topic: string; aggregate_id: string }, r: { status: number; body: any }): boolean {
    // 202: the marketplace has not bound the payer or seen the transfer finalize yet.
    if (r.status === 202) return false;
    const recorded = (r.status >= 200 && r.status < 300) || (r.status === 409 && typeof r.body?.receiptId === "string");
    if (recorded) {
      immediate(this.ledger.db, () => {
        acceptInbox(this.ledger, "marketplace", `mkt:${row.event_id}`, row.topic, { aggregateId: row.aggregate_id, topic: row.topic });
        markOutboxPublished(this.ledger, row.event_id);
      });
      return true;
    }
    const code = clip(r.body?.error?.code, 60) ?? `HTTP_${r.status}`;
    const message = clip(r.body?.error?.message, 300) ?? `marketplace refused the payment evidence (HTTP ${r.status})`;
    immediate(this.ledger.db, () => {
      const changed = this.ledger.db.prepare(`UPDATE outbox SET attempts = attempts + 1 WHERE event_id = ? AND published_at_ms IS NULL`).run(row.event_id).changes;
      if (changed !== 1) return;
      const attempts = num(this.ledger.db.prepare(`SELECT attempts FROM outbox WHERE event_id = ?`).pluck().get(row.event_id));
      writeAudit(this.ledger, {
        workspaceId: requireWorkspace(this.ledger).id,
        scope: `marketplace:${row.aggregate_id}`,
        actorType: "service",
        actorId: "marketplace",
        action: "marketplace.evidence.refused",
        policyResult: "not_applicable",
        reasonCode: code,
        details: { status: r.status, code, message, attempt: attempts, retryAfterMs: evidenceBackoffMs(attempts) },
      });
    });
    this.#log(`evidence for ${row.aggregate_id} refused (HTTP ${r.status} ${code}); retrying with backoff`);
    return false;
  }

  /** Latest refusal of a still-unpublished evidence report, with when it may be re-sent. */
  #evidenceRefusal(operationId: string): { code: string; reason: string; attempts: number; retryAtMs: number } | null {
    const pending = this.ledger.db
      .prepare(`SELECT attempts FROM outbox WHERE topic = 'marketplace.evidence' AND aggregate_id = ? AND published_at_ms IS NULL ORDER BY seq DESC LIMIT 1`)
      .pluck()
      .get(operationId) as bigint | undefined;
    if (pending === undefined || num(pending) === 0) return null;
    const audit = this.ledger.db
      .prepare(`SELECT reason_code, details_json, created_at_ms FROM audit_event WHERE scope = ? AND action = 'marketplace.evidence.refused' ORDER BY seq DESC LIMIT 1`)
      .get(`marketplace:${operationId}`) as { reason_code: string | null; details_json: string; created_at_ms: bigint } | undefined;
    const attempts = num(pending);
    if (!audit) return { code: "EVIDENCE_REJECTED", reason: "the marketplace refused the payment evidence", attempts, retryAtMs: 0 };
    const details = JSON.parse(audit.details_json) as { message?: unknown };
    return {
      code: audit.reason_code ?? "EVIDENCE_REJECTED",
      reason: typeof details.message === "string" ? details.message : "the marketplace refused the payment evidence",
      attempts,
      retryAtMs: num(audit.created_at_ms) + evidenceBackoffMs(attempts),
    };
  }

  // ---- agent tools ------------------------------------------------------------------------------

  /** Public catalogue search for a custom agent. Results are returned as untrusted data. */
  async search(query: string): Promise<{ label: string; items: Array<Record<string, unknown>> }> {
    const r = await this.deps.client.publicGet(`/marketplace/listings?q=${encodeURIComponent(query.slice(0, 100))}&limit=10`);
    if (r.status !== 200) throw new ControlError("PROVIDER_UNAVAILABLE", `marketplace catalogue unavailable (HTTP ${r.status})`);
    const list: unknown[] = Array.isArray(r.body?.listings) ? r.body.listings : [];
    const items = list.slice(0, 10).flatMap((raw) => {
      const e = raw as Record<string, unknown>;
      const listingId = clip(e.listingId ?? e.listing_id, 36);
      if (listingId === null || !/^[0-9a-f-]{36}$/.test(listingId)) return [];
      const price = clip(e.priceBaseUnits ?? e.price_base_units, 21);
      return [
        {
          listingId,
          title: clip(e.title, 120),
          summary: clip(e.summary, 500),
          description: clip(e.description, 1000),
          inputHint: clip(e.inputHint ?? e.input_hint, 300),
          outputFormat: clip(e.outputFormat ?? e.output_format, 40),
          sellerName: clip(e.sellerName ?? e.seller_name, 120),
          priceBaseUnits: price !== null && /^(0|[1-9][0-9]{0,19})$/.test(price) ? price : null,
          turnaroundMinutes: typeof (e.turnaroundMinutes ?? e.turnaround_minutes) === "number" ? (e.turnaroundMinutes ?? e.turnaround_minutes) : null,
        },
      ];
    });
    return { label: `${UNTRUSTED_LABEL} ${TEST_TOKEN_LABEL}.`, items };
  }

  /**
   * Asks the marketplace to quote one hire for this agent's task. It never pays: the resulting
   * payment request still needs a local owner approval or a matching owner listing grant.
   */
  async propose(agent: AgentRow, task: { id: string; input_json: string; max_purchases: bigint }, body: { listingId: string; brief: string; idempotencyKey: string }): Promise<Record<string, unknown>> {
    const depth = Number((JSON.parse(task.input_json) as Record<string, unknown>)[MARKETPLACE_DELEGATION_DEPTH_KEY] ?? 0);
    if (!Number.isInteger(depth) || depth >= MARKETPLACE_LIMITS.maxDelegationDepth) {
      throw new ControlError("POLICY_DENIED", "delegation depth limit reached: a specialist result cannot start further hires");
    }
    const parsed = agentHireProposalSchema.safeParse({ localAgentId: agent.id, listingId: body.listingId, brief: body.brief, idempotencyKey: body.idempotencyKey });
    if (!parsed.success) throw new ControlError("INVALID_REQUEST", "hire proposal does not match the marketplace contract");
    const proposalBody = parsed.data;
    const briefDigest = computeInputDigest(proposalBody.brief);
    const { proposal, eventId } = immediate(this.ledger.db, () => {
      const existing = this.ledger.db.prepare(`SELECT * FROM marketplace_proposal WHERE agent_id = ? AND idempotency_key = ?`).get(agent.id, body.idempotencyKey) as ProposalRow | undefined;
      if (existing) {
        if (existing.listing_id !== body.listingId || existing.brief_digest !== briefDigest || existing.task_id !== task.id) {
          throw new ControlError("IDEMPOTENCY_CONFLICT", "this hire key was already used with a different proposal");
        }
        return { proposal: existing, eventId: undefined };
      }
      const count = num(this.ledger.db.prepare(`SELECT count(*) FROM marketplace_proposal WHERE task_id = ?`).pluck().get(task.id));
      if (count >= num(task.max_purchases)) throw new ControlError("BUDGET_EXCEEDED", "task hire-proposal limit reached");
      const id = this.ledger.newId();
      const now = this.ledger.now();
      this.ledger.db
        .prepare(
          `INSERT INTO marketplace_proposal (id, workspace_id, agent_id, task_id, listing_id, idempotency_key, brief, brief_digest, delegation_depth,
             state, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(id, agent.workspace_id, agent.id, task.id, body.listingId, body.idempotencyKey, proposalBody.brief, briefDigest, depth, now, now);
      writeAudit(this.ledger, {
        workspaceId: agent.workspace_id,
        scope: `agent:${agent.id}`,
        actorType: "worker",
        actorId: agent.id,
        action: "marketplace.propose_hire",
        policyResult: "allowed",
        details: { proposalId: id, listingId: body.listingId, taskId: task.id, briefDigest },
      });
      const ev = enqueueOutbox(this.ledger, `${OUTBOX_PREFIX}proposal`, id, { proposalId: id });
      return { proposal: this.ledger.db.prepare(`SELECT * FROM marketplace_proposal WHERE id = ?`).get(id) as ProposalRow, eventId: ev };
    });
    if (eventId !== undefined) {
      await this.#deliver({ event_id: eventId, topic: `${OUTBOX_PREFIX}proposal`, aggregate_id: proposal.id }, proposalBody);
    }
    const p = this.ledger.db.prepare(`SELECT * FROM marketplace_proposal WHERE id = ?`).get(proposal.id) as ProposalRow;
    return {
      proposalId: p.id,
      state: p.state,
      listingId: p.listing_id,
      marketplace: p.remote_json ? (JSON.parse(p.remote_json) as unknown) : null,
      payment: "not paid: a hire is paid only after local owner approval or an owner-installed listing grant",
    };
  }

  #applyProposalReply(proposalId: string, status: number, body: unknown): void {
    const b = (body ?? {}) as Record<string, unknown>;
    const remote = {
      status,
      jobId: clip(b.jobId, 36),
      state: clip(b.state, 40),
      code: clip((b.error as Record<string, unknown> | undefined)?.code, 60),
    };
    this.ledger.db
      .prepare(`UPDATE marketplace_proposal SET state = ?, remote_json = ?, updated_at_ms = ? WHERE id = ? AND state = 'pending'`)
      .run(status >= 200 && status < 300 ? "submitted" : "refused", JSON.stringify(remote), this.ledger.now(), proposalId);
  }
}
