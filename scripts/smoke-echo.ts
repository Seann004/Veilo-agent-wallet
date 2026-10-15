// Explicit ordinary x402 smoke payment against PayAI's devnet Echo Merchant. One operation per
// invocation, no retry. Requires --key <keypair.json> and --confirm; never prints key material.
//
//   pnpm tsx scripts/smoke-echo.ts --inspect                      (read-only: challenge + facilitator check)
//   pnpm tsx scripts/smoke-echo.ts --key <path> --confirm         (one payment, 10,000 base-unit ceiling)
//   pnpm tsx scripts/smoke-echo.ts --reconcile <evidence.json>    (read-only: find an uncertain attempt on chain)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { address, createKeyPairSignerFromBytes, createSolanaRpc, devnet, signature as toSignature } from "@solana/kit";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { findRepoRoot, loadConfig, loadDotEnv, redactUrl, verifyChainIdentity } from "@veilo/contracts";
import {
  checkFacilitatorSupport,
  deriveAta,
  fetchFacilitatorSupported,
  keyPairPaymentWallet,
  payOnce,
  verifyPaymentRequired,
  type ApprovedServiceBinding,
} from "@veilo/x402-client";

const ECHO_URL = "https://x402.payai.network/api/solana-devnet/paid-content";
const ECHO_MERCHANT = "8sqyMHQwBh8BCXC99pdgt6BpXwLu9xqfL1hDV5SFYf3R";
const CEILING = 10_000n;

const { values } = parseArgs({
  options: {
    key: { type: "string" },
    confirm: { type: "boolean", default: false },
    inspect: { type: "boolean", default: false },
    reconcile: { type: "string" },
  },
});

const rootDir = findRepoRoot();
loadDotEnv({ rootDir });
const config = loadConfig(process.env, { rootDir });
const evidenceDir = join(rootDir, "artifacts", "evidence");
const rpc = createSolanaRpc(devnet(config.network.rpcUrl));
const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const log = (o: unknown) => console.log(JSON.stringify(o, bigintSafe, 2));

async function fetchChallenge(): Promise<PaymentRequired> {
  const res = await fetch(ECHO_URL, { redirect: "error" });
  if (res.status !== 402) throw new Error(`expected HTTP 402 from Echo merchant, got ${res.status}`);
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : undefined;
  return new x402HTTPClient(new x402Client()).getPaymentRequiredResponse((n) => res.headers.get(n), body);
}

async function binding(feePayers: string[]): Promise<ApprovedServiceBinding> {
  return {
    origin: new URL(ECHO_URL).origin,
    network: config.network.caip2,
    mint: config.network.mint,
    payTo: ECHO_MERCHANT,
    merchantAta: await deriveAta(ECHO_MERCHANT, config.network.mint),
    maxAmount: CEILING,
    allowedFeePayers: feePayers,
  };
}

async function preflight() {
  console.log(`RPC ${redactUrl(config.network.rpcUrl)}`);
  const identity = await verifyChainIdentity(config);
  const support = checkFacilitatorSupport(await fetchFacilitatorSupported(config.network.facilitatorUrl), {
    network: config.network.caip2,
    mint: config.network.mint,
  });
  if (!support.supported) throw new Error(`facilitator capability check failed: ${support.reason}`);
  const pr = await fetchChallenge();
  const verified = await verifyPaymentRequired(pr, await binding(support.feePayers));
  return { identity, support, pr, verified };
}

async function waitFinalized(sig: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tx = await rpc
      .getTransaction(toSignature(sig), { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 })
      .send();
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, 4_000));
  }
  return null;
}

async function main() {
  if (values.reconcile) {
    const record = JSON.parse(readFileSync(resolve(values.reconcile), "utf8")) as { payer: string; messageHash?: string };
    const sigs = await rpc.getSignaturesForAddress(address(record.payer), { limit: 10, commitment: "confirmed" }).send();
    log({ mode: "reconcile (read-only)", payer: record.payer, recentSignatures: sigs.map((s) => ({ signature: s.signature, slot: s.slot, err: s.err, confirmationStatus: s.confirmationStatus })) });
    return;
  }

  const { identity, support, pr, verified } = await preflight();
  if (values.inspect || !values.key || !values.confirm) {
    log({
      mode: "inspect (read-only, nothing signed)",
      chain: { genesisHash: identity.genesisHash, mint: identity.mint, decimals: identity.mintDecimals },
      facilitator: support,
      challenge: { resource: pr.resource, selected: verified.requirements },
    });
    if (!values.inspect) {
      console.error("Refusing to pay: an explicit --key <path> and --confirm are both required.");
      process.exitCode = 2;
    }
    return;
  }

  const keyPath = resolve(rootDir, values.key);
  if (!existsSync(keyPath)) throw new Error("key file not found");
  const raw = JSON.parse(readFileSync(keyPath, "utf8")) as number[];
  const bytes = Uint8Array.from(raw);
  raw.fill(0);
  const signer = await createKeyPairSignerFromBytes(bytes);
  bytes.fill(0);

  const payerAta = await deriveAta(signer.address, config.network.mint);
  const balance = await rpc.getTokenAccountBalance(payerAta, { commitment: "finalized" }).send();
  const lamports = await rpc.getBalance(signer.address, { commitment: "finalized" }).send();
  if (BigInt(balance.value.amount) < verified.amount) throw new Error("payer ATA balance below the challenge amount");

  mkdirSync(evidenceDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidencePath = join(evidenceDir, `x402-echo-smoke-${stamp}.json`);
  const record: Record<string, unknown> = {
    kind: "ordinary devnet x402 exact payment (no privacy)",
    url: ECHO_URL,
    network: config.network.caip2,
    genesisHash: identity.genesisHash,
    mint: config.network.mint,
    merchant: ECHO_MERCHANT,
    merchantAta: await deriveAta(ECHO_MERCHANT, config.network.mint),
    payer: signer.address,
    payerAta,
    payerBalanceBefore: { usdcBaseUnits: balance.value.amount, lamports: lamports.value.toString() },
    ceilingBaseUnits: CEILING.toString(),
    amountBaseUnits: verified.amount.toString(),
    facilitator: config.network.facilitatorUrl,
    facilitatorFeePayer: verified.feePayer,
    packages: { "@x402/core": "2.28.0", "@x402/svm": "2.28.0", "@solana/kit": "5.5.1" },
    attemptedAt: new Date().toISOString(),
    state: "signing",
  };
  // Persist the attempt before signing so an interrupted run is reconciled, not repeated.
  writeFileSync(evidencePath, JSON.stringify(record, bigintSafe, 2));

  let result;
  try {
    result = await payOnce({
      url: ECHO_URL,
      binding: await binding(support.feePayers),
      wallet: keyPairPaymentWallet(signer),
      purchaseRef: `echo-smoke-${stamp}`,
      rpcUrl: config.network.rpcUrl,
    });
  } catch (error) {
    record.state = "uncertain";
    record.error = (error as Error).message;
    writeFileSync(evidencePath, JSON.stringify(record, bigintSafe, 2));
    throw new Error(`payment outcome uncertain; do not rerun. Reconcile with --reconcile ${evidencePath}`, { cause: error });
  }
  record.messageHash = result.validated?.messageHash;
  record.httpStatus = result.status;
  record.settleResponse = result.settleResponse ?? null;
  record.responseExcerpt = JSON.stringify(result.body ?? null).slice(0, 400);
  const sig = result.settleResponse?.transaction;
  if (!sig) {
    record.state = "uncertain";
    writeFileSync(evidencePath, JSON.stringify(record, bigintSafe, 2));
    throw new Error(`no settlement signature returned; do not rerun. Reconcile with --reconcile ${evidencePath}`);
  }
  record.signature = sig;
  record.explorer = `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
  record.state = "submitted";
  writeFileSync(evidencePath, JSON.stringify(record, bigintSafe, 2));

  const tx = await waitFinalized(sig);
  if (!tx) {
    record.state = "not_finalized_within_wait";
  } else {
    const transfers = (tx.transaction.message.instructions as unknown as Array<{ parsed?: { type?: string; info?: Record<string, unknown> } }>)
      .filter((ix) => ix.parsed?.type === "transferChecked")
      .map((ix) => ix.parsed?.info);
    record.finalized = { slot: tx.slot.toString(), err: tx.meta?.err ?? null, blockTime: tx.blockTime?.toString() ?? null, transferChecked: transfers };
    record.state = tx.meta?.err ? "failed_on_chain" : "finalized";
  }
  writeFileSync(evidencePath, JSON.stringify(record, bigintSafe, 2));
  log({ evidence: evidencePath, state: record.state, httpStatus: result.status, signature: sig });
}

main().catch((error: unknown) => {
  console.error(`smoke-echo failed: ${(error as Error).message}`);
  process.exit(1);
});
