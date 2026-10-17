/**
 * Live access-control test against the configured Supabase project. Four throwaway wallets sign
 * in through Supabase Web3 auth; the marketplace API runs in process. Chain reads use a fixture
 * (labeled below) because this test exercises identity, RLS, storage and transitions, not
 * settlement; live receipt verification is part of the devnet demo run.
 *
 * Requires SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, the Web3 (Solana) auth
 * provider enabled and http://localhost:3000/** in the project's redirect URLs.
 */
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { generateKeyPair, getAddressFromPublicKey, getBase58Decoder, signBytes } from "@solana/kit";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DEVNET_GENESIS_HASH, DEMO_TOKEN_MINT, findRepoRoot, loadDotEnv } from "@veilo/contracts";
import {
  CONTROLLER_HEADERS,
  controllerRegistrationMessage,
  controllerSigningMessage,
  payerBindingMessage,
  runInputsDigest,
  stepToolDigest,
  workflowApprovalDigest,
  type WorkflowApprovalTerms,
} from "@veilo/contracts/marketplace";
import { createApp } from "../../services/marketplace/src/app";
import { deriveAta, type Chain, type ParsedTransaction } from "../../services/marketplace/src/chain";
import type { MarketplaceConfig } from "../../services/marketplace/src/config";
import { createDb } from "../../services/marketplace/src/db";
import { payoutProofMessage } from "../../services/marketplace/src/service";

// Response bodies are inspected loosely; each check asserts the fields it needs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
loadDotEnv({ rootDir: findRepoRoot(), allowMarketplaceSecrets: true });

const url = process.env.SUPABASE_URL ?? "";
const publishable = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
if (!url || !publishable || !process.env.SUPABASE_SECRET_KEY) {
  console.error("SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY are required");
  process.exit(2);
}

const results: Array<{ check: string; ok: boolean; detail?: string | undefined }> = [];
function record(check: string, ok: boolean, detail?: string) {
  results.push({ check, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${check}${detail ? ` — ${detail}` : ""}`);
}

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const b58 = getBase58Decoder();

interface Wallet {
  address: string;
  sign(message: string): Promise<string>;
  signRaw(message: string): Promise<Uint8Array>;
}

async function wallet(): Promise<Wallet> {
  const kp = await generateKeyPair();
  const address = await getAddressFromPublicKey(kp.publicKey);
  const signRaw = async (m: string) => new Uint8Array(await signBytes(kp.privateKey, new TextEncoder().encode(m)));
  return { address, signRaw, sign: async (m) => b58.decode(await signRaw(m)) };
}

async function signIn(w: Wallet): Promise<{ token: string; client: SupabaseClient }> {
  const client = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
  const message = [
    "localhost:3000 wants you to sign in with your Solana account:",
    w.address,
    "",
    "Sign in to Veilo marketplace. This is a login message, not a transaction or spending approval.",
    "",
    "Version: 1",
    "URI: http://localhost:3000/marketplace",
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  const { data, error } = await client.auth.signInWithWeb3({ chain: "solana", message, signature: await w.signRaw(message) });
  if (error || !data.session) throw new Error(`web3 sign-in failed: ${error?.message ?? "no session"}`);
  const token = data.session.access_token;
  return { token, client: createClient(url, publishable, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${token}` } } }) };
}

// Fresh per run: receipts are unique per signature and earlier runs' rows stay in the project.
const FIXTURE_SIG = getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(64)));
const FIXTURE_SIG_2 = getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(64)));

async function main() {
  const [buyerA, buyerB, seller, controllerKey, payerA, payerB] = await Promise.all([wallet(), wallet(), wallet(), wallet(), wallet(), wallet()]);
  const sellerAta = await deriveAta(seller.address, DEMO_TOKEN_MINT);
  const quoteTotals = new Map<string, bigint>();
  const fixtureChain: Chain = {
    genesisHash: async () => DEVNET_GENESIS_HASH,
    finalizedSlot: async () => 10n,
    tokenAccount: async (a) => (a === sellerAta ? { mint: DEMO_TOKEN_MINT, owner: seller.address } : null),
    finalizedTransaction: async (sig) => {
      if (sig !== FIXTURE_SIG && sig !== FIXTURE_SIG_2) return null;
      const amount = [...quoteTotals.values()][0] ?? 0n;
      const tx: ParsedTransaction = {
        slot: 100,
        blockTime: Math.floor(Date.now() / 1000),
        meta: { err: null, postTokenBalances: [{ accountIndex: 1, mint: DEMO_TOKEN_MINT, owner: seller.address }] },
        transaction: {
          message: {
            accountKeys: ["11111111111111111111111111111111", sellerAta],
            instructions: [{ program: "spl-token", parsed: { type: "transferChecked", info: { destination: sellerAta, mint: DEMO_TOKEN_MINT, authority: payerA.address, tokenAmount: { amount: amount.toString() } } } }],
          },
        },
      };
      return tx;
    },
  };
  const managedHostToken = `host_${randomUUID()}`;
  const operatorToken = `op_${randomUUID()}`;
  const config: MarketplaceConfig = {
    port: 0,
    bindHost: "127.0.0.1",
    supabaseUrl: url,
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY as string,
    supabasePublishableKey: publishable,
    rpcUrl: "fixture",
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    genesisHash: DEVNET_GENESIS_HASH,
    mint: DEMO_TOKEN_MINT,
    decimals: 6,
    sellerHostTokenHash: sha(managedHostToken),
    operatorTokenHash: sha(operatorToken),
    managedSellerOrigin: "http://127.0.0.1:6150",
    managedSellerIdentity: "veilo-seller-host-devnet",
    devSellerOrigins: [],
    allowedBrowserOrigins: [],
    maxNetworkFeeLamports: 10_000_000n,
    quoteTtlSeconds: 300,
    termsVersion: "2026-10-17",
    managedRuntimeRevision: "v2",
  };
  const db = createDb(config);
  const server = createApp({ db, chain: fixtureChain, config, now: () => new Date() }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as Json };
  };
  const signedCall = async (method: string, path: string, body: unknown, keyId: string) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const timestamp = new Date().toISOString();
    const nonce = `n_${randomUUID().replace(/-/g, "")}`;
    const sig = await controllerKey.sign(controllerSigningMessage({ method, path, bodyDigest: sha(raw), timestamp, nonce, keyId }));
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", [CONTROLLER_HEADERS.keyId]: keyId, [CONTROLLER_HEADERS.timestamp]: timestamp, [CONTROLLER_HEADERS.nonce]: nonce, [CONTROLLER_HEADERS.signature]: sig },
      ...(body === undefined ? {} : { body: raw }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as Json, replay: () => fetch(base + path, { method, headers: { "content-type": "application/json", [CONTROLLER_HEADERS.keyId]: keyId, [CONTROLLER_HEADERS.timestamp]: timestamp, [CONTROLLER_HEADERS.nonce]: nonce, [CONTROLLER_HEADERS.signature]: sig }, ...(body === undefined ? {} : { body: raw }) }) };
  };

  try {
    const [A, B, S] = await Promise.all([signIn(buyerA), signIn(buyerB), signIn(seller)]);
    record("three wallets signed in through Supabase Web3 auth (no transaction, no fee)", true);
    const anon = createClient(url, publishable, { auth: { persistSession: false } });

    const wsA = await call("POST", "/me/bootstrap", { token: A.token });
    const wsB = await call("POST", "/me/bootstrap", { token: B.token });
    await call("POST", "/me/bootstrap", { token: S.token });
    record("workspaces provisioned idempotently from the verified user", wsA.status === 200 && wsB.status === 200 && wsA.body.workspaceId !== wsB.body.workspaceId);
    const again = await call("POST", "/me/bootstrap", { token: A.token });
    record("bootstrap is idempotent", again.body?.workspaceId === wsA.body.workspaceId);

    const sp = await call("POST", "/seller/profile", { token: S.token, body: { publicName: "RLS test seller (fixture)", description: "access-control test" } });
    const issuedAt = new Date().toISOString();
    const proofMsg = payoutProofMessage({ userId: (await db.getUser(S.token))!.id, address: seller.address, network: config.network, mint: config.mint, issuedAt });
    const badPayout = await call("POST", "/seller/payouts", { token: S.token, body: { address: seller.address, issuedAt, signature: await buyerA.sign(proofMsg) } });
    record("payout address must be proven by its own key", badPayout.status === 403, `status ${badPayout.status}`);
    const payout = await call("POST", "/seller/payouts", { token: S.token, body: { address: seller.address, issuedAt, signature: await seller.sign(proofMsg) } });
    const slug = `rls-test-${randomUUID().slice(0, 8)}`;
    const listing = await call("POST", "/seller/listings", { token: S.token, body: { slug } });
    const version = await call("POST", `/seller/listings/${listing.body.listingId}/versions`, {
      token: S.token,
      body: {
        title: "RLS test research brief",
        summary: "Fixture listing used by the access-control test",
        description: "Fixture listing used by the access-control test; not a real service.",
        runtimeKind: "managed_template",
        template: "research-summary",
        remoteOrigin: null,
        sellerInstructions: "SELLER-ONLY-INSTRUCTION-MARKER",
        inputSchema: { briefHint: "topic", maxBriefChars: 4000 },
        outputSchema: { format: "markdown", sections: ["Summary"] },
        priceBaseUnits: "10000",
        payoutVersionId: payout.body.payoutVersionId,
        turnaroundMinutes: 30,
        refundTerms: "Seller-funded refund if nothing is delivered.",
        dataHandling: "Brief is sent to the managed model provider.",
        termsVersion: "2026-10-17",
      },
    });
    await call("POST", `/seller/versions/${version.body.versionId}/submit`, { token: S.token });
    const sellerAsOperator = await call("POST", `/operator/versions/${version.body.versionId}/review`, { token: S.token, body: { approve: true, note: null } });
    record("a seller cannot approve its own listing", sellerAsOperator.status === 401);
    await call("POST", `/operator/sellers/${sp.body.sellerId}/status`, { token: operatorToken, body: { status: "approved" } });
    const review = await call("POST", `/operator/versions/${version.body.versionId}/review`, { token: operatorToken, body: { approve: true, note: "rls test" } });
    record("operator review publishes the version", review.status === 200);

    const cat = await anon.from("catalog_entries").select("*").eq("slug", slug);
    record("anonymous users can read the sanitized catalogue", (cat.data?.length ?? 0) === 1);
    record("catalogue never exposes seller-only instructions", !JSON.stringify(cat.data).includes("SELLER-ONLY-INSTRUCTION-MARKER"));
    const anonVersions = await anon.from("listing_versions").select("*");
    record("anonymous users cannot read listing versions", (anonVersions.data?.length ?? 0) === 0);

    const hire = await call("POST", "/jobs", { token: A.token, body: { listingId: listing.body.listingId, brief: "Summarize x402 adoption on Solana devnet.", idempotencyKey: `idem-${randomUUID()}` } });
    record("buyer A received an immutable quote", hire.status === 200 && hire.body.quote.totalUnits === "10000" && hire.body.quote.recipient === seller.address);
    const jobId = hire.body.jobId as string;
    quoteTotals.set(jobId, BigInt(hire.body.quote.totalUnits));

    const bJob = await call("GET", `/jobs/${jobId}`, { token: B.token });
    record("buyer B cannot read buyer A's job through the API", bJob.status === 404, `status ${bJob.status}`);
    const bRest = await B.client.from("jobs").select("*").eq("id", jobId);
    record("buyer B cannot read buyer A's job through the database API", (bRest.data?.length ?? 0) === 0);
    const bInputs = await B.client.from("job_inputs").select("*").eq("job_id", jobId);
    record("buyer B cannot read buyer A's brief", (bInputs.data?.length ?? 0) === 0);
    const anonJobs = await anon.from("jobs").select("*");
    record("anonymous users cannot read jobs", (anonJobs.data?.length ?? 0) === 0);
    const bApprove = await call("POST", `/jobs/${jobId}/approve`, { token: B.token });
    record("buyer B cannot approve buyer A's job", bApprove.status === 404);
    const sApprove = await call("POST", `/jobs/${jobId}/approve`, { token: S.token });
    record("the seller cannot approve the buyer's job", sApprove.status === 404);

    const directUpdate = await A.client.from("jobs").update({ state: "queued" }).eq("id", jobId).select();
    record("buyers cannot update job state directly", (directUpdate.data?.length ?? 0) === 0);
    const quoteTamper = await S.client.from("quotes").update({ recipient: buyerA.address }).eq("job_id", jobId).select();
    record("the seller cannot change a quote's recipient", (quoteTamper.data?.length ?? 0) === 0);
    const rpcAttempt = await A.client.rpc("mk_record_receipt", { p_operation: "x", p_network: "x", p_signature: "x", p_ix: 0, p_mint: "x", p_source: null, p_ata: "x", p_amount: 1, p_slot: 1 });
    record("signed-in users cannot call transition functions", rpcAttempt.error !== null);

    await call("POST", `/jobs/${jobId}/approve`, { token: A.token });
    const keyId = `ctl_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const userA = (await db.getUser(A.token))!.id;
    const badReg = await call("POST", "/me/controller", { token: A.token, body: { controllerKey: controllerKey.address, keyId, proof: await buyerB.sign(controllerRegistrationMessage(wsA.body.workspaceId, userA, controllerKey.address, keyId)) } });
    record("controller registration requires proof of the controller key", badReg.status === 403);
    const reg = await call("POST", "/me/controller", { token: A.token, body: { controllerKey: controllerKey.address, keyId, proof: await controllerKey.sign(controllerRegistrationMessage(wsA.body.workspaceId, userA, controllerKey.address, keyId)) } });
    record("owner registered a local controller key", reg.status === 200);

    const reqs = await signedCall("GET", "/controller/payment-requests", undefined, keyId);
    record("controller sees the approved payment request", reqs.status === 200 && reqs.body.requests.some((r: Json) => r.jobId === jobId));
    const replay = await reqs.replay();
    record("a replayed controller request is refused", replay.status === 401);

    const accept = await signedCall("POST", `/controller/payment-requests/${hire.body.quote.operationId}/decision`, { decision: "accepted", code: null, controllerRef: "local-1" }, keyId);
    record("controller accepted the payment locally", accept.status === 200);
    const early = await signedCall("POST", `/controller/payments/${hire.body.quote.operationId}/evidence`, { operationId: hire.body.quote.operationId, signature: FIXTURE_SIG }, keyId);
    record("evidence before the payer is bound stays pending", early.status === 202);
    const op1 = hire.body.quote.operationId as string;
    const bind = async (op: string, digest: string, payer: Wallet, signer: Wallet = payer) =>
      signedCall("POST", `/controller/payment-requests/${op}/status`, { status: "paying", detail: null, payer: payer.address, payerProof: await signer.sign(payerBindingMessage(op, digest, payer.address)) }, keyId);
    const forged = await bind(op1, hire.body.quote.quoteDigest, payerA, buyerB);
    record("binding a payer requires a signature by that payer's key", forged.status === 403);
    const paying = await bind(op1, hire.body.quote.quoteDigest, payerA);
    record("controller bound the one-time payer to the operation", paying.status === 200);
    const rebind = await bind(op1, hire.body.quote.quoteDigest, payerB);
    record("a bound payer cannot be replaced", rebind.status === 409);
    const preClaim = await call("POST", `/internal/seller-host/jobs/${jobId}/claim`, { token: managedHostToken });
    record("no execution lease before settlement", preClaim.status === 503);

    const ev = await signedCall("POST", `/controller/payments/${hire.body.quote.operationId}/evidence`, { operationId: hire.body.quote.operationId, signature: FIXTURE_SIG }, keyId);
    record("fixture receipt matching the quote is recorded (fixture chain)", ev.status === 200 && ev.body.status === "settled", `status ${ev.status} ${JSON.stringify(ev.body)}`);
    const ev2 = await signedCall("POST", `/controller/payments/${hire.body.quote.operationId}/evidence`, { operationId: hire.body.quote.operationId, signature: FIXTURE_SIG }, keyId);
    record("duplicate evidence is a no-op", ev2.status === 200);

    const hire2 = await call("POST", "/jobs", { token: A.token, body: { listingId: listing.body.listingId, brief: "Second job", idempotencyKey: `idem-${randomUUID()}` } });
    await call("POST", `/jobs/${hire2.body.jobId}/approve`, { token: A.token });
    await signedCall("POST", `/controller/payment-requests/${hire2.body.quote.operationId}/decision`, { decision: "accepted", code: null, controllerRef: "local-2" }, keyId);
    const steal = await bind(hire2.body.quote.operationId, hire2.body.quote.quoteDigest, payerA);
    record("another operation cannot bind a payer that is already bound", steal.status === 409);
    await bind(hire2.body.quote.operationId, hire2.body.quote.quoteDigest, payerB);
    const reuse = await signedCall("POST", `/controller/payments/${hire2.body.quote.operationId}/evidence`, { operationId: hire2.body.quote.operationId, signature: FIXTURE_SIG }, keyId);
    record("one settlement signature cannot fund a second job", reuse.status === 403 || reuse.status === 409, `status ${reuse.status}`);

    const claim = await call("POST", `/internal/seller-host/jobs/${jobId}/claim`, { token: managedHostToken });
    record("seller host claimed a lease after settlement", claim.status === 200);
    const secondLease = await call("POST", `/internal/seller-host/jobs/${jobId}/claim`, { token: managedHostToken });
    record("a second live lease is refused", secondLease.status === 503);
    const text = "# Result\n\nFixture deliverable for the access-control test.\n";
    const artifactId = randomUUID();
    const envelope = {
      jobId,
      attemptId: claim.body.attemptId,
      leaseGeneration: claim.body.leaseGeneration,
      schemaVersion: "veilo.result.v1",
      status: "complete",
      summary: "Fixture deliverable",
      artifacts: [{ artifactId, sha256: sha(text), mimeType: "text/markdown", bytes: Buffer.byteLength(text) }],
      sourceReferences: [],
    };
    const badComplete = await call("POST", `/internal/seller-host/jobs/${jobId}/complete`, { token: managedHostToken, body: { attemptId: claim.body.attemptId, leaseToken: "x".repeat(43), envelope, artifactBodies: [{ artifactId, text }] } });
    record("completion with a wrong lease token is refused", badComplete.status === 403);
    const tampered = await call("POST", `/internal/seller-host/jobs/${jobId}/complete`, { token: managedHostToken, body: { attemptId: claim.body.attemptId, leaseToken: claim.body.leaseToken, envelope, artifactBodies: [{ artifactId, text: text + "tampered" }] } });
    record("an artifact whose hash does not match is refused", tampered.status === 400);
    const done = await call("POST", `/internal/seller-host/jobs/${jobId}/complete`, { token: managedHostToken, body: { attemptId: claim.body.attemptId, leaseToken: claim.body.leaseToken, envelope, artifactBodies: [{ artifactId, text }] } });
    record("the live lease completed the job", done.status === 200);

    const aDl = await call("POST", `/artifacts/${artifactId}/download`, { token: A.token });
    const fetched = aDl.status === 200 ? await (await fetch(aDl.body.url)).text() : "";
    record("buyer A downloads the deliverable through a short-lived link", fetched === text);
    const bDl = await call("POST", `/artifacts/${artifactId}/download`, { token: B.token });
    record("buyer B cannot obtain a download link", bDl.status === 404);
    const bStorage = await B.client.storage.from("job-files").download(`jobs/${jobId}/${claim.body.attemptId}/${artifactId}`);
    record("buyer B cannot read the object from storage directly", bStorage.error !== null);
    const aStorage = await A.client.storage.from("job-files").download(`jobs/${jobId}/${claim.body.attemptId}/${artifactId}`);
    record("even the buyer reads private files only through the signed-link API", aStorage.error !== null);

    const sPayer = await S.client.from("payment_operations").select("expected_payer").eq("job_id", jobId);
    record("the seller cannot read the buyer's one-time payer", sPayer.error !== null);
    const sJob = await call("GET", `/jobs/${jobId}`, { token: S.token });
    record("the assigned seller sees the job", sJob.status === 200);
    const dash = await call("GET", "/seller/dashboard", { token: S.token });
    record("seller earnings show one settled payment with zero fee", dash.body?.earnings?.length === 1 && dash.body.totals[0]?.platformFee === "0" && dash.body.totals[0]?.gross === "10000");
    const bEarn = await B.client.from("earnings_events").select("*");
    record("buyer B sees no seller earnings", (bEarn.data?.length ?? 0) === 0);

    const refundForeign = await call("POST", `/jobs/${jobId}/refund-requests`, { token: A.token, body: { amount: "5000", returnAddress: seller.address, reason: "test" } });
    record("refund return address must be the buyer's own verified wallet", refundForeign.status === 403);
    const refundOver = await call("POST", `/jobs/${jobId}/refund-requests`, { token: A.token, body: { amount: "10001", returnAddress: buyerA.address, reason: "test" } });
    record("a refund above the settled payment is refused as a client error", refundOver.status === 400, `status ${refundOver.status}`);
    const refundOk = await call("POST", `/jobs/${jobId}/refund-requests`, { token: A.token, body: { amount: "6000", returnAddress: buyerA.address, reason: "partial" } });
    const refundTwo = await call("POST", `/jobs/${jobId}/refund-requests`, { token: A.token, body: { amount: "6000", returnAddress: buyerA.address, reason: "second" } });
    const approveOne = await call("POST", `/refunds/${refundOk.body?.refundId}/decision`, { token: S.token, body: { approve: true } });
    const approveTwo = await call("POST", `/refunds/${refundTwo.body?.refundId}/decision`, { token: S.token, body: { approve: true } });
    record("two refunds cannot together exceed the settled payment", approveOne.status === 200 && approveTwo.status === 400, `statuses ${approveOne.status}/${approveTwo.status}`);
    const bDecide = await call("POST", `/refunds/${refundTwo.body?.refundId}/decision`, { token: B.token, body: { approve: true } });
    record("only the assigned seller can decide a refund", bDecide.status === 404);
    const decline = await call("POST", `/refunds/${refundTwo.body?.refundId}/decision`, { token: S.token, body: { approve: false } });
    const afterDecline = await call("GET", `/jobs/${jobId}`, { token: A.token });
    record("declining one refund keeps the claim open while another approved refund is pending", decline.status === 200 && afterDecline.body?.job?.financial_state === "refund_requested", `financial ${afterDecline.body?.job?.financial_state}`);
    const earlyRefund = await call("POST", `/jobs/${hire2.body.jobId}/refund-requests`, { token: A.token, body: { amount: "1", returnAddress: buyerA.address, reason: "early" } });
    record("a refund cannot be requested while a job can still run", earlyRefund.status === 409 || earlyRefund.status === 503, `status ${earlyRefund.status}`);

    // ---- workflows (§26.7) ---------------------------------------------------------------------
    const wfSlug = `rls-wf-${randomUUID().slice(0, 8)}`;
    const wf = await call("POST", "/creator/workflows", { token: S.token, body: { slug: wfSlug, category: "research" } });
    record("any signed-in creator with a payout profile can create a workflow", wf.status === 200, `status ${wf.status}`);
    const wfBody = (over: Record<string, unknown> = {}) => ({
      category: "research",
      title: "RLS test workflow",
      summary: "Fixture workflow used by the access-control test.",
      description: "One paid step over the fixture listing; not a real service.",
      safetyPromise: "",
      runInputs: [{ name: "topic", label: "Topic", maxChars: 200 }],
      steps: [{ toolKind: "listing", toolId: version.body.versionId, maxBaseUnits: "10000", inputs: { brief: { from: "run_input", name: "topic" } } }],
      totalMaxBaseUnits: "10000",
      payoutVersionId: payout.body.payoutVersionId,
      sampleOutput: null,
      ...over,
    });
    const badTotal = await call("POST", `/creator/workflows/${wf.body.workflowId}/versions`, { token: S.token, body: wfBody({ totalMaxBaseUnits: "9000" }) });
    record("a workflow whose total differs from its step maxima is refused before storage", badTotal.status === 400 && (badTotal.body?.problems ?? []).includes("total must equal the sum of step maxima"));
    const wv = await call("POST", `/creator/workflows/${wf.body.workflowId}/versions`, { token: S.token, body: wfBody() });
    const pub = await call("POST", `/creator/versions/${wv.body?.versionId}/publish`, { token: S.token });
    record("a workflow of approved, published tools goes live without review", wv.body?.decision === "live" && pub.body?.status === "live", `decision ${wv.body?.decision} publish ${pub.body?.status}`);
    const anonWf = await anon.from("workflow_catalog").select("slug, steps").eq("slug", wfSlug);
    record("anonymous users read the live workflow from the sanitized catalogue", (anonWf.data?.length ?? 0) === 1 && anonWf.data?.[0]?.steps?.[0]?.recipient === seller.address);
    const anonDrafts = await anon.from("workflow_versions").select("id").eq("workflow_id", wf.body.workflowId);
    const otherDrafts = await B.client.from("workflow_versions").select("id").eq("workflow_id", wf.body.workflowId);
    const ownDrafts = await S.client.from("workflow_versions").select("id").eq("workflow_id", wf.body.workflowId);
    record("workflow drafts are visible to their creator only", (anonDrafts.data?.length ?? 0) === 0 && (otherDrafts.data?.length ?? 0) === 0 && (ownDrafts.data?.length ?? 0) === 1);
    const clientWrite = await S.client.from("workflow_catalog").update({ total_base_units: 1 }).eq("slug", wfSlug).select("slug");
    record("clients cannot write the workflow catalogue", (clientWrite.data?.length ?? 0) === 0);

    const extPayTo = await wallet();
    const ext = await call("POST", "/tools/external", {
      token: B.token,
      body: {
        slug: `rls-ext-${randomUUID().slice(0, 8)}`,
        title: "RLS fixture paid RPC",
        summary: "Fixture external x402 tool for the access-control test.",
        origin: "https://rpc.example.com",
        resourcePath: "/solana-mainnet",
        payTo: extPayTo.address,
        payToAta: await deriveAta(extPayTo.address, DEMO_TOKEN_MINT),
        unitPriceBaseUnits: "1000",
        callsPerStep: 3,
        feePayers: [controllerKey.address],
        rpcMethods: ["getSlot"],
        io: { inputs: [{ name: "query", kind: "text", required: true, maxChars: 500 }], output: { kind: "json" } },
        callTemplate: [0, 1, 2].map((id) => ({ method: "POST", path: "/solana-mainnet", body: { jsonrpc: "2.0", id, method: "getSlot", params: [{ commitment: "finalized" }] } })),
      },
    });
    const anonExt = await anon.from("external_tools").select("id").eq("id", ext.body?.toolId ?? "");
    record("a proposed external tool waits for review and is not public", ext.status === 200 && ext.body?.status === "pending" && (anonExt.data?.length ?? 0) === 0);
    const wf2Slug = `rls-wf2-${randomUUID().slice(0, 8)}`;
    const wf2 = await call("POST", "/creator/workflows", { token: S.token, body: { slug: wf2Slug, category: "data" } });
    const wv2 = await call("POST", `/creator/workflows/${wf2.body.workflowId}/versions`, {
      token: S.token,
      body: wfBody({
        category: "data",
        steps: [
          { toolKind: "external", toolId: ext.body?.toolId, maxBaseUnits: "3000", inputs: { query: { from: "run_input", name: "topic" } } },
          { toolKind: "listing", toolId: version.body.versionId, maxBaseUnits: "10000", inputs: { brief: { from: "step", step: 0 } } },
        ],
        totalMaxBaseUnits: "13000",
      }),
    });
    const pub2 = await call("POST", `/creator/versions/${wv2.body?.versionId}/publish`, { token: S.token });
    const notLive = await anon.from("workflow_catalog").select("slug").eq("slug", wf2Slug);
    record("a workflow that uses a tool in review goes to review, not live", wv2.body?.decision === "review" && pub2.body?.status === "in_review" && (notLive.data?.length ?? 0) === 0, `decision ${wv2.body?.decision}`);
    await call("POST", `/operator/external-tools/${ext.body?.toolId}/status`, { token: operatorToken, body: { status: "approved", note: "rls test" } });
    const rev2 = await call("POST", `/operator/workflow-versions/${wv2.body?.versionId}/review`, { token: operatorToken, body: { approve: true, note: null } });
    record("operator review publishes it once its tools are approved", rev2.body?.result === "live", `result ${rev2.body?.result}`);

    const terms: WorkflowApprovalTerms = {
      workflowVersionId: wv.body.versionId,
      network: config.network,
      mint: config.mint,
      steps: [{ toolKind: "listing", toolId: version.body.versionId, recipient: seller.address, maxBaseUnits: "10000", toolDigest: stepToolDigest({ toolKind: "listing", toolId: version.body.versionId, recipient: seller.address }) }],
      totalMaxBaseUnits: "10000",
      runInputsDigest: runInputsDigest({ topic: "repair cafes" }),
    };
    const runReq = (t: WorkflowApprovalTerms, digest = workflowApprovalDigest(t), key = `wfrun-${randomUUID()}`) =>
      signedCall("POST", "/controller/workflow-runs", { idempotencyKey: key, terms: t, approvalDigest: digest, localAgentId: null, isTest: false }, keyId);
    const wrongRecipient = { ...terms, steps: [{ ...terms.steps[0]!, recipient: buyerA.address, toolDigest: stepToolDigest({ toolKind: "listing", toolId: version.body.versionId, recipient: buyerA.address }) }] };
    const badRun = await runReq(wrongRecipient);
    const badDigest = await runReq(terms, "0".repeat(64));
    const badTool = await runReq({ ...terms, steps: [{ ...terms.steps[0]!, toolDigest: "f".repeat(64) }] });
    record("a run whose approval covers different tool terms is refused", badTool.status === 409, `status ${badTool.status}`);
    record("a run whose approval names another recipient or digest is refused", badRun.status === 409 && badDigest.status === 409, `statuses ${badRun.status}/${badDigest.status}`);
    const run = await runReq(terms);
    record("the local controller records a run bound to the approved terms", run.status === 200 && typeof run.body?.runId === "string");
    const runA = await A.client.from("workflow_runs").select("id").eq("id", run.body?.runId ?? "");
    const runB = await B.client.from("workflow_runs").select("id").eq("id", run.body?.runId ?? "");
    const stepsB = await B.client.from("workflow_run_steps").select("run_id").eq("run_id", run.body?.runId ?? "");
    record("workflow runs and their steps are private to the buyer", (runA.data?.length ?? 0) === 1 && (runB.data?.length ?? 0) === 0 && (stepsB.data?.length ?? 0) === 0);
    await signedCall("POST", `/controller/workflow-runs/${run.body?.runId}/report`, { status: "approved", stopReason: null, steps: [] }, keyId);
    await signedCall("POST", `/controller/workflow-runs/${run.body?.runId}/report`, { status: "running", stopReason: null, steps: [] }, keyId);
    const fakeDone = await signedCall("POST", `/controller/workflow-runs/${run.body?.runId}/report`, { status: "completed", stopReason: null, steps: [] }, keyId);
    record("a run cannot complete while a step is unpaid", fakeDone.status === 409, `status ${fakeDone.status}`);
    const skipAhead = await signedCall("POST", `/controller/workflow-runs/${run.body?.runId}/report`, { status: "rejected", stopReason: null, steps: [] }, keyId);
    record("run status follows its state machine", skipAhead.status === 409, `status ${skipAhead.status}`);
    const fakePaid = await signedCall(
      "POST",
      `/controller/workflow-runs/${run.body?.runId}/report`,
      { status: "running", stopReason: null, steps: [{ index: 0, paymentStatus: "paid", executionStatus: "delivered", jobId: jobId, paidBaseUnits: "10000", fundingSignature: null, merchantSignatures: [FIXTURE_SIG], artifactSha256: null, stopReason: null }] },
      keyId,
    );
    record("a controller cannot claim a step paid with another job's receipt", fakePaid.status === 403, `status ${fakePaid.status}`);
    const draftSlug = `rls-wf3-${randomUUID().slice(0, 8)}`;
    const wf3 = await call("POST", "/creator/workflows", { token: S.token, body: { slug: draftSlug, category: "research" } });
    const wv3 = await call("POST", `/creator/workflows/${wf3.body.workflowId}/versions`, { token: S.token, body: wfBody() });
    const peek = await signedCall("GET", `/controller/workflow-versions/${wv3.body?.versionId}`, undefined, keyId);
    const peekLive = await signedCall("GET", `/controller/workflow-versions/${wv.body?.versionId}`, undefined, keyId);
    record("a buyer's controller reads live workflow versions only, never another creator's draft", peek.status === 404 && peekLive.status === 200, `draft ${peek.status} live ${peekLive.status}`);

    const terms2: WorkflowApprovalTerms = {
      workflowVersionId: wv2.body.versionId,
      network: config.network,
      mint: config.mint,
      steps: [
        {
          toolKind: "external",
          toolId: ext.body.toolId,
          recipient: extPayTo.address,
          maxBaseUnits: "3000",
          toolDigest: stepToolDigest({
            toolKind: "external",
            toolId: ext.body.toolId,
            origin: "https://rpc.example.com",
            resourcePath: "/solana-mainnet",
            payTo: extPayTo.address,
            payToAta: await deriveAta(extPayTo.address, DEMO_TOKEN_MINT),
            unitPriceBaseUnits: "1000",
            callsPerStep: 3,
            feePayers: [controllerKey.address],
            rpcMethods: ["getSlot"],
            callTemplate: [0, 1, 2].map((id) => ({ method: "POST", path: "/solana-mainnet", body: { jsonrpc: "2.0", id, method: "getSlot", params: [{ commitment: "finalized" }] } })),
          }),
        },
        { toolKind: "listing", toolId: version.body.versionId, recipient: seller.address, maxBaseUnits: "10000", toolDigest: stepToolDigest({ toolKind: "listing", toolId: version.body.versionId, recipient: seller.address }) },
      ],
      totalMaxBaseUnits: "13000",
      runInputsDigest: runInputsDigest({ topic: "token supply" }),
    };
    const run2 = await runReq(terms2);
    const run2Id = run2.body?.runId as string;
    const [stepPayer, stepPayer2] = await Promise.all([wallet(), wallet()]);
    const bindAs = (p: Wallet) => payerBindingMessage(`wf:${run2Id}:0`, workflowApprovalDigest(terms2), p.address);
    const hirePayer = await signedCall("POST", `/controller/workflow-runs/${run2Id}/steps/0/payer`, { payer: payerA.address, payerProof: await payerA.sign(bindAs(payerA)) }, keyId);
    const forgedPayer = await signedCall("POST", `/controller/workflow-runs/${run2Id}/steps/0/payer`, { payer: stepPayer.address, payerProof: await payerA.sign(bindAs(stepPayer)) }, keyId);
    const bound = await signedCall("POST", `/controller/workflow-runs/${run2Id}/steps/0/payer`, { payer: stepPayer.address, payerProof: await stepPayer.sign(bindAs(stepPayer)) }, keyId);
    const rebindPayer = await signedCall("POST", `/controller/workflow-runs/${run2Id}/steps/0/payer`, { payer: stepPayer2.address, payerProof: await stepPayer2.sign(bindAs(stepPayer2)) }, keyId);
    record("an external step's payer is bound once, only with that payer's own proof", forgedPayer.status === 403 && bound.status === 200 && rebindPayer.status === 409, `forged ${forgedPayer.status} bound ${bound.status} rebind ${rebindPayer.status}`);
    record("a payer already bound to a hire cannot be bound to a workflow step", hirePayer.status === 409, `status ${hirePayer.status}`);
    const unboundPaid = await signedCall(
      "POST",
      `/controller/workflow-runs/${run.body?.runId}/report`,
      { status: "running", stopReason: null, steps: [{ index: 0, paymentStatus: "paid", executionStatus: "running", jobId: null, paidBaseUnits: null, fundingSignature: null, merchantSignatures: [FIXTURE_SIG_2], artifactSha256: null, stopReason: null }] },
      keyId,
    );
    record("a listing step cannot be reported paid without its own hire", unboundPaid.status === 400, `status ${unboundPaid.status}`);

    const suspend = await call("POST", `/operator/workflows/${wf.body.workflowId}/status`, { token: operatorToken, body: { status: "suspended" } });
    const gone = await anon.from("workflow_catalog").select("slug").eq("slug", wfSlug);
    const halted = await A.client.from("workflow_runs").select("status").eq("id", run.body?.runId ?? "").single();
    const afterSuspend = await runReq(terms);
    record("operator suspension removes the workflow, halts its runs and refuses new ones", suspend.status === 200 && (gone.data?.length ?? 0) === 0 && halted.data?.status === "halted" && afterSuspend.status === 403, `run ${halted.data?.status} new ${afterSuspend.status}`);
    const resume = await signedCall("POST", `/controller/workflow-runs/${run.body?.runId}/report`, { status: "approved", stopReason: null, steps: [] }, keyId);
    record("a halted run cannot resume while its workflow is suspended", resume.status === 403, `status ${resume.status}`);
    const reviewWhileSuspended = await call("POST", `/creator/versions/${wv.body?.versionId}/publish`, { token: S.token });
    record("a creator cannot republish a suspended workflow", reviewWhileSuspended.status === 403, `status ${reviewWhileSuspended.status}`);
    await call("POST", `/operator/external-tools/${ext.body?.toolId}/status`, { token: operatorToken, body: { status: "suspended", note: "rls test cleanup" } });
    const extGone = await anon.from("workflow_catalog").select("slug").eq("slug", wf2Slug);
    record("suspending a tool removes every workflow that uses it", (extGone.data?.length ?? 0) === 0);

    // Higgsfield tools are sold only as workflow steps.
    const hfSlug = `rls-hf-${randomUUID().slice(0, 8)}`;
    const hfListing = await call("POST", "/seller/listings", { token: S.token, body: { slug: hfSlug } });
    const hfVersion = await call("POST", `/seller/listings/${hfListing.body.listingId}/versions`, {
      token: S.token,
      body: {
        title: "RLS fixture Higgsfield tool",
        summary: "Fixture provider tool for the access-control test",
        description: "Fixture provider tool for the access-control test; not a real service.",
        runtimeKind: "remote_endpoint",
        template: null,
        remoteOrigin: "https://provider-tools.rls.veilo.invalid",
        sellerInstructions: "",
        inputSchema: { briefHint: "prompt", maxBriefChars: 2000 },
        outputSchema: { format: "markdown", sections: [] },
        priceBaseUnits: "10000",
        payoutVersionId: payout.body.payoutVersionId,
        turnaroundMinutes: 30,
        refundTerms: "Seller-funded refund if nothing is delivered.",
        dataHandling: "Prompt is sent to the provider.",
        termsVersion: "2026-10-17",
      },
    });
    const hfProfile = await call("POST", `/seller/versions/${hfVersion.body.versionId}/tool-profile`, {
      token: S.token,
      body: { toolKind: "provider_adapter", provider: "higgsfield", toolName: "generate_image", effect: "read_only", io: { inputs: [{ name: "prompt", kind: "text", required: true, maxChars: 2000 }], output: { kind: "image_url" } } },
    });
    await call("POST", `/seller/versions/${hfVersion.body.versionId}/submit`, { token: S.token });
    await call("POST", `/operator/versions/${hfVersion.body.versionId}/review`, { token: operatorToken, body: { approve: true, note: "rls test" } });
    const directHire = await call("POST", "/jobs", { token: A.token, body: { listingId: hfListing.body.listingId, brief: "a red bicycle", idempotencyKey: `direct-${randomUUID()}` } });
    const hfOnly = await call("POST", "/creator/workflows", { token: S.token, body: { slug: `rls-hfonly-${randomUUID().slice(0, 8)}`, category: "media" } });
    const hfOnlyVersion = await call("POST", `/creator/workflows/${hfOnly.body.workflowId}/versions`, {
      token: S.token,
      body: wfBody({ category: "media", runInputs: [{ name: "topic", label: "Prompt", maxChars: 200 }], steps: [{ toolKind: "listing", toolId: hfVersion.body.versionId, maxBaseUnits: "10000", inputs: { prompt: { from: "run_input", name: "topic" } } }] }),
    });
    record("a workflow (even a draft for a test run) cannot consist of a workflow-only provider alone", hfOnlyVersion.status === 400, `status ${hfOnlyVersion.status}`);
    const filler = await call("POST", `/creator/workflows/${hfOnly.body.workflowId}/versions`, {
      token: S.token,
      body: wfBody({
        category: "media",
        runInputs: [{ name: "topic", label: "Prompt", maxChars: 200 }],
        steps: [
          { toolKind: "listing", toolId: version.body.versionId, maxBaseUnits: "10000", inputs: { brief: { from: "run_input", name: "topic" } } },
          { toolKind: "listing", toolId: hfVersion.body.versionId, maxBaseUnits: "10000", inputs: { prompt: { from: "run_input", name: "topic" } } },
        ],
        totalMaxBaseUnits: "20000",
      }),
    });
    record("a filler step cannot wrap a workflow-only provider fed straight from the buyer", filler.status === 400, `status ${filler.status}`);
    const forgedKey = await call("POST", "/jobs", { token: A.token, body: { listingId: hfListing.body.listingId, brief: "a red bicycle", idempotencyKey: `wf:${randomUUID()}:0` } });
    record("a Higgsfield tool cannot be hired on its own, only as a workflow step", hfProfile.status === 200 && directHire.status === 403 && forgedKey.status === 403, `profile ${hfProfile.status} hire ${directHire.status} forged ${forgedKey.status}`);
    await call("POST", `/operator/listings/${hfListing.body.listingId}/status`, { token: operatorToken, body: { status: "archived" } });

    await call("POST", `/operator/listings/${listing.body.listingId}/status`, { token: operatorToken, body: { status: "archived" } });
  } finally {
    server.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(`rls-e2e aborted: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
