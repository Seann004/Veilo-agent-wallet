/**
 * Devnet smoke of the marketplace merchant leg with PUBLIC funding. A fresh payer is funded by an
 * ordinary public transfer from the funding wallet, so this run proves the seller leg (quote,
 * x402 settlement to the seller's payout wallet, chain-verified receipt, managed fulfilment with
 * real inference and artifact delivery) and nothing about pool privacy. The private pool leg is
 * exercised by `pnpm demo:run`.
 *
 *   pnpm marketplace:devnet-smoke             read-only preflight and plan
 *   pnpm marketplace:devnet-smoke --confirm   sign and send devnet transactions (resumable)
 *
 * State and throwaway keys live under work/marketplace-smoke (gitignored, 0600). Key material is
 * never printed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { address, createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes, getBase58Decoder, signBytes, type KeyPairSigner } from "@solana/kit";
import { createClient } from "@supabase/supabase-js";
import { findRepoRoot, loadConfig, loadDotEnv, redactUrl, verifyChainIdentity } from "@veilo/contracts";
import { computeRequestDigest } from "@veilo/contracts/gateway";
import {
  CONTROLLER_HEADERS,
  controllerRegistrationMessage,
  controllerSigningMessage,
  payerBindingMessage,
  TEST_TOKEN_LABEL,
} from "@veilo/contracts/marketplace";
import { checkFacilitatorSupport, fetchFacilitatorSupported, keyPairPaymentWallet, payOnce } from "@veilo/x402-client";
import { createApp } from "../../services/marketplace/src/app";
import { createRpcChain } from "../../services/marketplace/src/chain";
import type { MarketplaceConfig } from "../../services/marketplace/src/config";
import { createDb } from "../../services/marketplace/src/db";
import { payoutProofMessage } from "../../services/marketplace/src/service";
import { ata, awaitTx, createAtaIdempotentIx, explorerTx, makeRpc, signAndSend, systemTransferIx, transferCheckedIx, type SentTx } from "../devnet/lib";

const PRICE = 10_000n; // 0.01 test USDC
const PAYER_LAMPORTS = 0n; // the facilitator pays fees; the payer needs only the token balance
const MARKET_PORT = 6420;
const HOST_PORT = 6421;
const confirm = process.argv.includes("--confirm");

const rootDir = findRepoRoot();
loadDotEnv({ rootDir, allowMarketplaceSecrets: true });
const config = loadConfig(process.env, { rootDir });
const rpc = makeRpc(config.network.rpcUrl);
const workDir = join(rootDir, "work", "marketplace-smoke");
const keyDir = join(workDir, "keys");
const statePath = join(workDir, "state.json");
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const b58 = getBase58Decoder();

type State = Record<string, unknown> & { steps: Record<string, unknown> };
const state: State = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as State) : { steps: {} };
function save(): void {
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  writeFileSync(statePath, JSON.stringify(state, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2), { mode: 0o600 });
}
function step(name: string, value: unknown): void {
  state.steps[name] = value;
  save();
  console.log(`✓ ${name}`);
}

/** Throwaway smoke keys are stored as 32-byte seeds (0600) so a rerun resumes with the same wallets. */
async function keyFor(name: string): Promise<KeyPairSigner> {
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const path = join(keyDir, `${name}.seed.json`);
  if (!existsSync(path)) writeFileSync(path, JSON.stringify([...randomBytes(32)]), { mode: 0o600 });
  chmodSync(path, 0o600);
  const seed = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  seed.fill(0);
  return signer;
}

async function signText(signer: KeyPairSigner, message: string): Promise<Uint8Array> {
  return new Uint8Array(await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(message)));
}

async function supabaseSession(signer: KeyPairSigner): Promise<string> {
  const url = process.env.SUPABASE_URL as string;
  const client = createClient(url, process.env.SUPABASE_PUBLISHABLE_KEY as string, { auth: { persistSession: false, autoRefreshToken: false } });
  const message = [
    "localhost:3000 wants you to sign in with your Solana account:",
    signer.address,
    "",
    "Sign in to Veilo marketplace. This is a login message, not a transaction or spending approval.",
    "",
    "Version: 1",
    "URI: http://localhost:3000/marketplace",
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  const { data, error } = await client.auth.signInWithWeb3({ chain: "solana", message, signature: await signText(signer, message) });
  if (error || !data.session) throw new Error(`web3 sign-in failed: ${error?.message ?? "no session"}`);
  return data.session.access_token;
}

async function sendOnce(name: string, payer: KeyPairSigner, ixs: Parameters<typeof signAndSend>[3]): Promise<string> {
  const prior = state.steps[name] as { sent?: SentTx; signature?: string } | undefined;
  if (prior?.signature) return prior.signature;
  let sent = prior?.sent;
  if (!sent) sent = await signAndSend(rpc, payer, [], ixs, (s) => step(name, { sent: s }));
  const outcome = await awaitTx(rpc, sent);
  if (outcome.state !== "finalized") throw new Error(`${name}: transaction ${outcome.state}; rerun to reconcile (it will not be re-signed while pending)`);
  if (outcome.outcome.err) throw new Error(`${name}: transaction failed on chain`);
  step(name, { sent, signature: sent.signature, explorer: explorerTx(sent.signature) });
  return sent.signature;
}

async function main(): Promise<void> {
  console.log(`Marketplace devnet smoke — PUBLIC FUNDING (merchant leg only). ${TEST_TOKEN_LABEL}`);
  console.log(`RPC ${redactUrl(config.network.rpcUrl)}`);
  const identity = await verifyChainIdentity(config);
  const support = checkFacilitatorSupport(await fetchFacilitatorSupported(config.network.facilitatorUrl), { network: config.network.caip2, mint: config.network.mint });
  if (!support.supported) throw new Error(`facilitator does not support devnet exact for the mint: ${support.reason}`);
  const fundingPath = process.env.FUNDING_KEY_PATH;
  if (!fundingPath || !existsSync(join(rootDir, fundingPath))) throw new Error("FUNDING_KEY_PATH is not set or the key file is missing");
  const funding = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(join(rootDir, fundingPath), "utf8")) as number[]));
  const mint = address(config.network.mint);
  const fundingAta = await ata(funding.address, mint);
  const fundingUsdc = BigInt((await rpc.getTokenAccountBalance(fundingAta, { commitment: "finalized" }).send()).value.amount);
  const fundingSol = (await rpc.getBalance(funding.address, { commitment: "finalized" }).send()).value;

  const [seller, buyer, controllerKey, payer] = await Promise.all(["seller", "buyer", "controller", "payer"].map(keyFor)) as [KeyPairSigner, KeyPairSigner, KeyPairSigner, KeyPairSigner];
  const sellerAta = await ata(seller.address, mint);
  const payerAta = await ata(payer.address, mint);
  console.log(JSON.stringify({
    genesis: identity.genesisHash,
    facilitatorFeePayers: support.feePayers,
    funding: { address: funding.address, sol: fundingSol.toString(), usdcBaseUnits: fundingUsdc.toString() },
    seller: { payout: seller.address, ata: sellerAta },
    payer: payer.address,
    priceBaseUnits: PRICE.toString(),
  }, null, 2));
  if (fundingUsdc < PRICE) throw new Error("funding wallet has less test USDC than the price");
  if (!confirm) {
    console.log("Read-only preflight complete. Re-run with --confirm to sign and send devnet transactions.");
    return;
  }

  // 1. Public funding: seller payout token account, payer token account and the exact price.
  await sendOnce("tx.sellerAta", funding, [createAtaIdempotentIx(funding.address, sellerAta, seller.address, mint)]);
  await sendOnce("tx.fundPayer", funding, [
    createAtaIdempotentIx(funding.address, payerAta, payer.address, mint),
    transferCheckedIx(fundingAta, mint, payerAta, funding.address, PRICE, config.network.mintDecimals),
    ...(PAYER_LAMPORTS > 0n ? [systemTransferIx(funding.address, payer.address, PAYER_LAMPORTS)] : []),
  ]);

  // 2. Marketplace API in process, seller host as its own process.
  const hostToken = (state.hostToken as string | undefined) ?? `host_${randomBytes(24).toString("base64url")}`;
  const operatorToken = (state.operatorToken as string | undefined) ?? `op_${randomBytes(24).toString("base64url")}`;
  state.hostToken = hostToken;
  state.operatorToken = operatorToken;
  save();
  const marketConfig: MarketplaceConfig = {
    port: MARKET_PORT,
    bindHost: "127.0.0.1",
    supabaseUrl: process.env.SUPABASE_URL as string,
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY as string,
    supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY as string,
    rpcUrl: config.network.rpcUrl,
    network: config.network.caip2,
    genesisHash: identity.genesisHash,
    mint: config.network.mint,
    decimals: config.network.mintDecimals,
    sellerHostTokenHash: sha(hostToken),
    operatorTokenHash: sha(operatorToken),
    managedSellerOrigin: `http://127.0.0.1:${HOST_PORT}`,
    managedSellerIdentity: "veilo-seller-host-devnet",
    devSellerOrigins: [],
    allowedBrowserOrigins: [],
    maxNetworkFeeLamports: 10_000_000n,
    quoteTtlSeconds: 300,
    termsVersion: "2026-10-17",
  };
  const server = createApp({ db: createDb(marketConfig), chain: createRpcChain(config.network.rpcUrl), config: marketConfig, now: () => new Date() }).listen(MARKET_PORT, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const market = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let host: ChildProcess | undefined;
  try {
    host = spawn("node_modules/.bin/tsx", ["services/gateway/src/index.ts"], {
      cwd: rootDir,
      env: {
        ...process.env,
        SUPABASE_SECRET_KEY: "",
        GATEWAY_ROLE: "seller-host",
        SELLER_HOST_PORT: String(HOST_PORT),
        SELLER_HOST_PUBLIC_ORIGIN: `http://127.0.0.1:${HOST_PORT}`,
        SELLER_HOST_DATABASE_PATH: join(workDir, "seller-host.sqlite"),
        SELLER_HOST_RECIPIENTS: seller.address,
        MARKETPLACE_URL: market,
        MARKETPLACE_SELLER_HOST_TOKEN: hostToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const hostLog: string[] = [];
    host.stdout?.on("data", (d: Buffer) => hostLog.push(d.toString()));
    host.stderr?.on("data", (d: Buffer) => hostLog.push(d.toString()));
    const hostUrl = `http://127.0.0.1:${HOST_PORT}`;
    for (let i = 0; ; i++) {
      const ok = await fetch(`${hostUrl}/health`).then((r) => r.ok, () => false);
      if (ok) break;
      if (i > 60) throw new Error(`seller host did not start:\n${hostLog.join("").slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 1_000));
    }

    const call = async (method: string, path: string, token?: string, body?: unknown) => {
      const res = await fetch(market + path, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = (await res.json().catch(() => null)) as Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (!res.ok && res.status !== 202) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
      return { status: res.status, body: json ?? {} };
    };
    const keyId = (state.keyId as string | undefined) ?? `ctl_${randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9_-]/g, "")}`;
    state.keyId = keyId;
    save();
    const signed = async (method: string, path: string, body?: unknown) => {
      const raw = body === undefined ? "" : JSON.stringify(body);
      const timestamp = new Date().toISOString();
      const nonce = `n_${randomUUID().replace(/-/g, "")}`;
      const sig = b58.decode(await signText(controllerKey, controllerSigningMessage({ method, path, bodyDigest: sha(raw), timestamp, nonce, keyId })));
      const res = await fetch(market + path, {
        method,
        headers: { "content-type": "application/json", [CONTROLLER_HEADERS.keyId]: keyId, [CONTROLLER_HEADERS.timestamp]: timestamp, [CONTROLLER_HEADERS.nonce]: nonce, [CONTROLLER_HEADERS.signature]: sig },
        ...(body === undefined ? {} : { body: raw }),
      });
      const json = (await res.json().catch(() => null)) as Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (!res.ok && res.status !== 202) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
      return { status: res.status, body: json ?? {} };
    };

    // 3. Seller publishes a reviewed managed listing paid to its own verified payout wallet.
    const sellerToken = await supabaseSession(seller);
    const buyerToken = await supabaseSession(buyer);
    const sellerBoot = await call("POST", "/me/bootstrap", sellerToken);
    const buyerBoot = await call("POST", "/me/bootstrap", buyerToken);
    let listing = state.steps.listing as { listingId: string; versionId: string } | undefined;
    if (!listing) {
      const profile = await call("POST", "/seller/profile", sellerToken, { publicName: "Veilo devnet demo seller", description: "Managed research specialist used for the devnet demo." });
      const issuedAt = new Date().toISOString();
      const proof = b58.decode(await signText(seller, payoutProofMessage({ userId: sellerBoot.body.userId, address: seller.address, network: config.network.caip2, mint: config.network.mint, issuedAt })));
      const payout = await call("POST", "/seller/payouts", sellerToken, { address: seller.address, issuedAt, signature: proof });
      const created = await call("POST", "/seller/listings", sellerToken, { slug: `devnet-research-${randomBytes(3).toString("hex")}` });
      const version = await call("POST", `/seller/listings/${created.body.listingId}/versions`, sellerToken, {
        title: "Devnet demo: cited research brief",
        summary: "A short, sourced research brief on a topic you provide.",
        description: "Managed research-summary template run by the Veilo seller host. Devnet demonstration listing; test tokens only.",
        runtimeKind: "managed_template",
        template: "research-summary",
        remoteOrigin: null,
        sellerInstructions: "Keep the brief under 400 words. Mark any claim you cannot support as unverified.",
        inputSchema: { briefHint: "Topic and the question you want answered", maxBriefChars: 2000 },
        outputSchema: { format: "markdown", sections: [] },
        priceBaseUnits: PRICE.toString(),
        payoutVersionId: payout.body.payoutVersionId,
        turnaroundMinutes: 10,
        refundTerms: "Seller-funded refund of the full price if no deliverable is produced.",
        dataHandling: "Your brief is sent to the operator's OpenRouter account to produce the deliverable.",
        termsVersion: "2026-10-17",
      });
      await call("POST", `/seller/versions/${version.body.versionId}/submit`, sellerToken);
      await call("POST", `/operator/sellers/${profile.body.sellerId}/status`, operatorToken, { status: "approved" });
      await call("POST", `/operator/versions/${version.body.versionId}/review`, operatorToken, { approve: true, note: "devnet demo review" });
      listing = { listingId: created.body.listingId, versionId: version.body.versionId };
      step("listing", listing);
    }

    // 4. Buyer hires and approves; the controller accepts and binds the one-time payer.
    let hire = state.steps.hire as { jobId: string; quote: Record<string, string> } | undefined;
    if (!hire) {
      const h = await call("POST", "/jobs", buyerToken, {
        listingId: listing.listingId,
        brief: "In about 200 words: what is the x402 payment protocol and how does Solana devnet settlement work for it?",
        idempotencyKey: `smoke-${randomUUID()}`,
      });
      hire = { jobId: h.body.jobId, quote: h.body.quote };
      step("hire", hire);
      await call("POST", `/jobs/${hire.jobId}/approve`, buyerToken);
      const userId = buyerBoot.body.userId as string;
      const proof = b58.decode(await signText(controllerKey, controllerRegistrationMessage(buyerBoot.body.workspaceId, userId, controllerKey.address, keyId)));
      await call("POST", "/me/controller", buyerToken, { controllerKey: controllerKey.address, keyId, proof });
    }
    const op = hire.quote.operationId as string;
    if (!state.steps.bound) {
      const requests = await signed("GET", "/controller/payment-requests");
      if (!(requests.body.requests as Array<{ operationId: string }>).some((r) => r.operationId === op)) throw new Error("payment request not visible to the controller");
      await signed("POST", `/controller/payment-requests/${op}/decision`, { decision: "accepted", code: null, controllerRef: "devnet-smoke" });
      const payerProof = b58.decode(await signText(payer, payerBindingMessage(op, hire.quote.quoteDigest as string, payer.address)));
      await signed("POST", `/controller/payment-requests/${op}/status`, { status: "paying", detail: "public-funding smoke", payer: payer.address, payerProof });
      step("bound", { payer: payer.address });
    }

    // 5. Ordinary x402 payment from the payer to the seller host's quoted recipient.
    let paid = state.steps.paid as { signature: string } | undefined;
    if (!paid) {
      if (state.steps.paying) throw new Error("a payment attempt was started but not recorded; reconcile the payer's history before retrying");
      const account = await fetch(`${hostUrl}/v1/accounts`, { method: "POST" }).then((r) => r.json() as Promise<{ token: string }>);
      const input = { jobId: hire.jobId, listingVersionId: listing.versionId, quoteDigest: hire.quote.quoteDigest as string, brief: "In about 200 words: what is the x402 payment protocol and how does Solana devnet settlement work for it?" };
      const gwOp = `smoke_${hire.jobId}`;
      const requestDigest = computeRequestDigest("specialist-job", input);
      const quoteRes = await fetch(`${hostUrl}/quotes`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${account.token}` },
        body: JSON.stringify({ operationId: gwOp, sku: "specialist-job", input, requestDigest }),
      });
      const gwQuote = (await quoteRes.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (!quoteRes.ok) throw new Error(`seller host quote refused: ${JSON.stringify(gwQuote)}`);
      if (gwQuote.recipient.payTo !== seller.address || gwQuote.charge.amount !== PRICE.toString()) throw new Error("seller host quote does not pay the seller the listed price");
      step("paying", { gatewayQuoteId: gwQuote.quoteId });
      const result = await payOnce({
        url: gwQuote.executeUrl,
        init: { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${account.token}` }, body: JSON.stringify({ operationId: gwOp, requestDigest }) },
        binding: { origin: hostUrl, network: config.network.caip2, mint: config.network.mint, payTo: seller.address, merchantAta: sellerAta, maxAmount: PRICE, allowedFeePayers: support.feePayers },
        wallet: keyPairPaymentWallet(payer),
        purchaseRef: hire.jobId,
        rpcUrl: config.network.rpcUrl,
      });
      const sig = result.settleResponse?.transaction;
      if (!sig) throw new Error(`no settlement signature (HTTP ${result.status}); reconcile the payer's history before retrying`);
      paid = { signature: sig };
      step("paid", { signature: sig, explorer: explorerTx(sig), httpStatus: result.status });
    }

    // 6. Evidence until finalized, then wait for the seller host to deliver.
    for (let i = 0; i < 40; i++) {
      const ev = await signed("POST", `/controller/payments/${op}/evidence`, { operationId: op, signature: paid.signature });
      if (ev.body.status === "settled") break;
      await new Promise((r) => setTimeout(r, 5_000));
    }
    let job: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (let i = 0; i < 90; i++) {
      job = (await call("GET", `/jobs/${hire.jobId}`, buyerToken)).body;
      if (["succeeded", "failed", "delivery_uncertain"].includes(job.job.state)) break;
      await new Promise((r) => setTimeout(r, 5_000));
    }
    const artifacts = job.artifacts as Array<{ id: string; sha256: string; bytes: number }>;
    let deliverable = "";
    if (job.job.state === "succeeded" && artifacts[0]) {
      const link = await call("POST", `/artifacts/${artifacts[0].id}/download`, buyerToken);
      deliverable = await (await fetch(link.body.url)).text();
      if (sha(deliverable) !== artifacts[0].sha256) throw new Error("downloaded deliverable does not match its recorded hash");
    }
    const seller2 = await call("GET", "/seller/dashboard", sellerToken);
    const evidence = {
      kind: "marketplace devnet smoke — PUBLIC FUNDING merchant leg (no pool privacy)",
      label: TEST_TOKEN_LABEL,
      recordedAt: new Date().toISOString(),
      network: config.network.caip2,
      mint: config.network.mint,
      seller: { payout: seller.address, payoutAta: sellerAta },
      payer: payer.address,
      fundingTransactions: { sellerAta: state.steps["tx.sellerAta"], fundPayer: state.steps["tx.fundPayer"] },
      settlement: { signature: paid.signature, explorer: explorerTx(paid.signature) },
      job: { id: hire.jobId, state: job.job.state, financialState: job.job.financial_state, events: (job.events as Array<{ kind: string }>).map((e) => e.kind) },
      receipt: job.receipt,
      artifact: artifacts[0] ? { sha256: artifacts[0].sha256, bytes: artifacts[0].bytes, excerpt: deliverable.slice(0, 600) } : null,
      sellerEarnings: seller2.body.totals,
    };
    const out = join(rootDir, "artifacts", "evidence", `marketplace-devnet-smoke-${evidence.recordedAt.replace(/[:.]/g, "-")}.json`);
    writeFileSync(out, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ evidence: out, jobState: job.job.state, financialState: job.job.financial_state, settlement: explorerTx(paid.signature) }, null, 2));
    if (job.job.state !== "succeeded") {
      console.error(`seller host log tail:\n${hostLog.join("").slice(-3000)}`);
      process.exitCode = 1;
    }
  } finally {
    host?.kill("SIGTERM");
    server.close();
  }
}

main().catch((error: unknown) => {
  console.error(`marketplace devnet smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
