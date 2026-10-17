import { computeRequestDigest } from "@veilo/contracts/gateway";
import type { StepInput, ToolEffect, ToolIo } from "@veilo/contracts/marketplace";
import { big, type Ledger } from "../context";
import { ControlError } from "../errors";
import { ExternalBatchRunner } from "../external/batch";
import { approveExternalBinding, EXTERNAL_BATCH_SKU, externalBindingForService, listExternalBindings, type ExternalBindingRow } from "../external/bindings";
import type { PurchaseOrchestrator } from "../integration/orchestrator";
import { authorizePurchase } from "../ledger/authorize";
import { getPurchaseRow } from "../ledger/purchases";
import { requireWorkspace } from "../ledger/workspace";
import type { MarketplaceBridge } from "../marketplace/bridge";
import type { MarketplaceClient } from "../marketplace/client";
import type { ExternalPort, ExternalToolFacts, HirePort, StepToolFacts, WorkflowMarketPort, WorkflowVersionFacts } from "./runner";

function ok<T>(r: { status: number; body: unknown }, what: string): T {
  if (r.status >= 200 && r.status < 300) return r.body as T;
  const err = (r.body as { error?: { code?: string; message?: string } } | undefined)?.error;
  const code = (err?.code ?? (r.status >= 500 ? "NOT_READY" : "SERVICE_NOT_ALLOWED")) as ConstructorParameters<typeof ControlError>[0];
  throw new ControlError(code, `${what}: ${err?.message ?? `HTTP ${r.status}`}`);
}

interface ExternalRow {
  id: string;
  origin: string;
  resource_path: string;
  pay_to: string;
  pay_to_ata: string;
  unit_price_base_units: string | number;
  calls_per_step: number;
  fee_payers: string[];
  rpc_methods: string[] | null;
  call_template: ExternalToolFacts["callTemplate"];
}

/** Signed controller calls to the hosted marketplace. */
export class MarketplaceWorkflowPort implements WorkflowMarketPort {
  constructor(private readonly client: MarketplaceClient) {}

  async version(versionId: string): Promise<WorkflowVersionFacts> {
    const body = ok<{
      version: {
        id: string;
        workflow_id: string;
        steps: WorkflowVersionFacts["steps"];
        run_inputs: WorkflowVersionFacts["runInputs"];
        total_max_base_units: string | number;
        network: string;
        mint: string;
      };
      live: boolean;
      tools: Array<{ toolKind: "listing" | "external"; toolId: string; current: boolean; priceBaseUnits: string; recipient: string; effect: ToolEffect; io: ToolIo; listingId: string | null } | null>;
      externalTools: ExternalRow[];
    }>(await this.client.signed("GET", `/controller/workflow-versions/${versionId}`), "workflow version unavailable");
    const ext = new Map(body.externalTools.map((e) => [e.id, e]));
    const tools: StepToolFacts[] = body.version.steps.map((s, i) => {
      const t = body.tools[i];
      if (!t) throw new ControlError("SERVICE_NOT_ALLOWED", `step ${i} tool is not available`);
      const e = s.toolKind === "external" ? ext.get(s.toolId) : undefined;
      return {
        toolKind: t.toolKind,
        toolId: t.toolId,
        current: t.current,
        priceBaseUnits: t.priceBaseUnits,
        recipient: t.recipient,
        effect: t.effect,
        io: t.io,
        listingId: t.listingId,
        external: e
          ? {
              id: e.id,
              origin: e.origin,
              resourcePath: e.resource_path,
              payTo: e.pay_to,
              payToAta: e.pay_to_ata,
              unitPriceBaseUnits: String(e.unit_price_base_units),
              callsPerStep: e.calls_per_step,
              feePayers: e.fee_payers,
              rpcMethods: e.rpc_methods,
              callTemplate: e.call_template,
            }
          : null,
      };
    });
    return {
      versionId: body.version.id,
      workflowId: body.version.workflow_id,
      live: body.live,
      network: body.version.network,
      mint: body.version.mint,
      totalMaxBaseUnits: String(body.version.total_max_base_units),
      runInputs: body.version.run_inputs,
      steps: body.version.steps.map((s) => ({ toolKind: s.toolKind, toolId: s.toolId, maxBaseUnits: s.maxBaseUnits, inputs: s.inputs as Record<string, StepInput> })),
      tools,
    };
  }

  async createRun(r: Parameters<WorkflowMarketPort["createRun"]>[0]): Promise<{ runId: string }> {
    return ok<{ runId: string }>(await this.client.signed("POST", "/controller/workflow-runs", r), "workflow run not recorded");
  }

  async report(cloudRunId: string, r: Parameters<WorkflowMarketPort["report"]>[1]): Promise<void> {
    ok(await this.client.signed("POST", `/controller/workflow-runs/${cloudRunId}/report`, r), "workflow run report refused");
  }

  async deliverable(jobId: string): ReturnType<WorkflowMarketPort["deliverable"]> {
    return ok(await this.client.signed("GET", `/controller/jobs/${jobId}/deliverable`), "deliverable unavailable");
  }

  async bindPayer(cloudRunId: string, index: number, payer: string, payerProof: string): Promise<void> {
    ok(await this.client.signed("POST", `/controller/workflow-runs/${cloudRunId}/steps/${index}/payer`, { payer, payerProof }), "payer binding refused");
  }
}

/** Listing steps reuse the marketplace bridge: the hire, its quote checks and its private payment. */
export class BridgeHirePort implements HirePort {
  constructor(
    private readonly bridge: MarketplaceBridge,
    private readonly ledger: Ledger,
  ) {}

  async hire(r: { listingId: string; brief: string; idempotencyKey: string; localAgentId: string }) {
    const body = ok<{ jobId: string; operationId: string; quote: { listingVersionId: string; recipient: string; totalUnits: string; network: string; mint: string; quoteDigest: string } }>(
      await this.bridge.deps.client.signed("POST", "/controller/hires", r),
      "hire not created",
    );
    return { jobId: body.jobId, operationId: body.operationId, quote: body.quote };
  }

  async approve(operationId: string, t: { quoteDigest: string; recipient: string; totalUnits: bigint; agentId: string }, ownerPubkey: string): Promise<boolean> {
    let h = this.bridge.hire(operationId);
    if (!h) {
      await this.bridge.poll();
      h = this.bridge.hire(operationId);
    }
    if (!h) return false;
    if (h.state === "received") return false;
    if (h.state !== "awaiting_approval") return true;
    const ws = requireWorkspace(this.ledger);
    await this.bridge.approve({ workspaceId: ws.id, ownerPubkey }, operationId, { quoteDigest: t.quoteDigest, recipient: t.recipient, totalUnits: t.totalUnits.toString(), agentId: t.agentId });
    return true;
  }

  async status(operationId: string) {
    const h = this.bridge.hire(operationId);
    if (!h) return { state: "unknown", fundingSignature: null, merchantSignature: null, purchaseId: null, paidUsdc: null };
    const funding = h.purchase_id
      ? (this.ledger.db.prepare(`SELECT signature FROM chain_attempt WHERE purchase_id = ? AND leg = 'funding' AND signature IS NOT NULL ORDER BY attempt_no DESC LIMIT 1`).pluck().get(h.purchase_id) as string | undefined)
      : undefined;
    return {
      state: h.state,
      fundingSignature: funding ?? null,
      merchantSignature: h.evidence_signature,
      purchaseId: h.purchase_id,
      paidUsdc: h.state === "paid" ? big(h.total_units) : null,
    };
  }

  async reject(operationId: string, ownerPubkey: string, reason: string): Promise<void> {
    if (!this.bridge.hire(operationId)) await this.bridge.poll();
    if (!this.bridge.hire(operationId)) return;
    const ws = requireWorkspace(this.ledger);
    await this.bridge.reject({ workspaceId: ws.id, ownerPubkey }, operationId, reason);
  }
}

/** External steps install the owner-approved binding for the tool and buy one batch through it. */
export class LocalExternalPort implements ExternalPort {
  constructor(
    private readonly ledger: Ledger,
    private readonly orchestrator: PurchaseOrchestrator,
    private readonly batches: ExternalBatchRunner,
    private readonly maxBatchUsdc: bigint,
  ) {}

  /** Reuses an identical approved binding, or approves one from the run's tool terms. */
  async #binding(tool: ExternalToolFacts, approvedBy: string): Promise<ExternalBindingRow> {
    const ws = requireWorkspace(this.ledger);
    const same = listExternalBindings(this.ledger, ws.id).find(
      (b) =>
        b.status === "approved" &&
        b.origin === tool.origin &&
        b.resource_path === tool.resourcePath &&
        b.pay_to === tool.payTo &&
        b.pay_to_ata === tool.payToAta &&
        big(b.unit_price_usdc) === BigInt(tool.unitPriceBaseUnits) &&
        Number(b.max_calls) === tool.callsPerStep &&
        b.allowed_fee_payers_json === JSON.stringify(tool.feePayers) &&
        b.allowed_rpc_methods_json === (tool.rpcMethods === null ? null : JSON.stringify(tool.rpcMethods)),
    );
    if (same) return same;
    return approveExternalBinding(
      this.ledger,
      ws.id,
      approvedBy,
      {
        label: `Workflow tool ${tool.id.slice(0, 8)}`,
        origin: tool.origin,
        resourcePath: tool.resourcePath,
        network: ws.network,
        mint: ws.mint,
        payTo: tool.payTo,
        payToAta: tool.payToAta,
        unitPriceUsdc: BigInt(tool.unitPriceBaseUnits),
        maxCalls: tool.callsPerStep,
        allowedFeePayers: tool.feePayers,
        allowedRpcMethods: tool.rpcMethods ?? undefined,
      },
      this.batches.deps.origins,
      this.maxBatchUsdc,
      "workflow",
    );
  }

  async authorize(r: Parameters<ExternalPort["authorize"]>[0]): Promise<{ purchaseId: string }> {
    const binding = await this.#binding(r.tool, r.approvedBy);
    const ws = requireWorkspace(this.ledger);
    const input = { bindingId: binding.id, calls: r.calls };
    const { purchase } = authorizePurchase(this.ledger, {
      workspaceId: ws.id,
      agentId: r.agentId,
      idempotencyKey: r.idempotencyKey,
      serviceId: binding.service_id,
      sku: EXTERNAL_BATCH_SKU,
      paymentPath: "private_x402",
      requestDigest: computeRequestDigest(EXTERNAL_BATCH_SKU, input),
      taskId: r.taskId,
      proposedByTask: r.taskId !== undefined,
      rationale: "workflow step",
    });
    this.orchestrator.storeInput(purchase, input);
    return { purchaseId: purchase.id };
  }

  async drive(purchaseId: string): Promise<void> {
    await this.orchestrator.drive(purchaseId);
  }

  async signPayer(purchaseId: string, operationId: string, digest: string) {
    const ex = this.orchestrator.execution(purchaseId);
    const funding = this.orchestrator.deps.funding;
    if (!ex?.funding_ref || !ex.merchant_payer || !funding.signPayerBinding) return null;
    const signed = await funding.signPayerBinding({ purchaseId, fundingRef: ex.funding_ref, operationId, quoteDigest: digest });
    if (signed.status === "not_ready") return null;
    if (signed.status === "refused") return { refused: signed.reason };
    if (signed.payer !== ex.merchant_payer) return { refused: "signed payer differs from the funding attempt's payer" };
    return { payer: signed.payer, proof: signed.proof };
  }

  async status(purchaseId: string): ReturnType<ExternalPort["status"]> {
    const p = getPurchaseRow(this.ledger, purchaseId);
    const result = this.batches.result(purchaseId) as { calls: Array<{ index: number; payment: string; settlementSignature: string | null }> };
    const paidCalls = result.calls.filter((c) => c.payment === "paid");
    const binding = externalBindingForService(this.ledger, p.service_id);
    const unit = binding ? big(binding.unit_price_usdc) : 0n;
    const payment = p.merchant_state === "finalized" ? "paid" : ["expired_unsettled", "abandoned"].includes(p.merchant_state) || p.authorization_state === "rejected" ? "not_paid" : "pending";
    const execution = p.fulfilment_state === "delivered" ? "delivered" : p.fulfilment_state === "paid_without_result" ? "no_result" : "pending";
    const funding = this.ledger.db
      .prepare(`SELECT signature FROM chain_attempt WHERE purchase_id = ? AND leg = 'funding' AND signature IS NOT NULL ORDER BY attempt_no DESC LIMIT 1`)
      .pluck()
      .get(purchaseId) as string | undefined;
    return {
      payment,
      execution: payment === "not_paid" ? "no_result" : execution,
      paidUsdc: BigInt(paidCalls.length) * unit,
      fundingSignature: funding ?? null,
      signatures: paidCalls.map((c) => c.settlementSignature).filter((s): s is string => s !== null),
      responses: result.calls.map((c) => this.batches.response(purchaseId, c.index)),
    };
  }
}
