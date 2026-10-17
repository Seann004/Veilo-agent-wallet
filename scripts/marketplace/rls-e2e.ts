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
import { CONTROLLER_HEADERS, controllerRegistrationMessage, controllerSigningMessage } from "@veilo/contracts/marketplace";
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

const FIXTURE_SIG = "5".repeat(88);
const FIXTURE_SIG_2 = "6".repeat(88);

async function main() {
  const [buyerA, buyerB, seller, controllerKey] = await Promise.all([wallet(), wallet(), wallet(), wallet()]);
  const sellerAta = await deriveAta(seller.address, DEMO_TOKEN_MINT);
  const quoteTotals = new Map<string, bigint>();
  const fixtureChain: Chain = {
    genesisHash: async () => DEVNET_GENESIS_HASH,
    tokenAccount: async (a) => (a === sellerAta ? { mint: DEMO_TOKEN_MINT, owner: seller.address } : null),
    finalizedTransaction: async (sig) => {
      if (sig !== FIXTURE_SIG && sig !== FIXTURE_SIG_2) return null;
      const amount = [...quoteTotals.values()][0] ?? 0n;
      const tx: ParsedTransaction = {
        slot: 1,
        meta: { err: null, postTokenBalances: [{ accountIndex: 1, mint: DEMO_TOKEN_MINT, owner: seller.address }] },
        transaction: {
          message: {
            accountKeys: ["11111111111111111111111111111111", sellerAta],
            instructions: [{ program: "spl-token", parsed: { type: "transferChecked", info: { destination: sellerAta, mint: DEMO_TOKEN_MINT, authority: buyerA.address, tokenAmount: { amount: amount.toString() } } } }],
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
    const preClaim = await call("POST", `/internal/seller-host/jobs/${jobId}/claim`, { token: managedHostToken });
    record("no execution lease before settlement", preClaim.status === 503);

    const ev = await signedCall("POST", `/controller/payments/${hire.body.quote.operationId}/evidence`, { operationId: hire.body.quote.operationId, signature: FIXTURE_SIG }, keyId);
    record("fixture receipt matching the quote is recorded (fixture chain)", ev.status === 200 && ev.body.status === "settled");
    const ev2 = await signedCall("POST", `/controller/payments/${hire.body.quote.operationId}/evidence`, { operationId: hire.body.quote.operationId, signature: FIXTURE_SIG }, keyId);
    record("duplicate evidence is a no-op", ev2.status === 200);

    const hire2 = await call("POST", "/jobs", { token: A.token, body: { listingId: listing.body.listingId, brief: "Second job", idempotencyKey: `idem-${randomUUID()}` } });
    await call("POST", `/jobs/${hire2.body.jobId}/approve`, { token: A.token });
    const reuse = await signedCall("POST", `/controller/payments/${hire2.body.quote.operationId}/evidence`, { operationId: hire2.body.quote.operationId, signature: FIXTURE_SIG }, keyId);
    record("one settlement signature cannot fund a second job", reuse.status === 409, `status ${reuse.status}`);

    const claim = await call("POST", `/internal/seller-host/jobs/${jobId}/claim`, { token: managedHostToken });
    record("seller host claimed a lease after settlement", claim.status === 200);
    const steal = await call("POST", `/internal/seller-host/jobs/${jobId}/claim`, { token: managedHostToken });
    record("a second live lease is refused", steal.status === 503);
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

    const sJob = await call("GET", `/jobs/${jobId}`, { token: S.token });
    record("the assigned seller sees the job", sJob.status === 200);
    const dash = await call("GET", "/seller/dashboard", { token: S.token });
    record("seller earnings show one settled payment with zero fee", dash.body?.earnings?.length === 1 && dash.body.totals[0]?.platformFee === "0" && dash.body.totals[0]?.gross === "10000");
    const bEarn = await B.client.from("earnings_events").select("*");
    record("buyer B sees no seller earnings", (bEarn.data?.length ?? 0) === 0);

    const refundForeign = await call("POST", `/jobs/${jobId}/refund-requests`, { token: A.token, body: { amount: "5000", returnAddress: seller.address, reason: "test" } });
    record("refund return address must be the buyer's own verified wallet", refundForeign.status === 403);
    const refundOver = await call("POST", `/jobs/${jobId}/refund-requests`, { token: A.token, body: { amount: "10001", returnAddress: buyerA.address, reason: "test" } });
    if (refundOver.status === 200) {
      const decision = await call("POST", `/refunds/${refundOver.body.refundId}/decision`, { token: S.token, body: { approve: true } });
      record("refunds cannot exceed the settled payment", decision.status === 400 || decision.status === 409 || decision.status === 500, `status ${decision.status}`);
    } else {
      record("refunds cannot exceed the settled payment", true, `request refused with ${refundOver.status}`);
    }

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
