/**
 * Seeds the workflow marketplace with demo creators, tools and workflows so the catalogue is not
 * empty. Every creator and listing is labeled demo. Managed tools run on Veilo's seller host with
 * operator-funded inference; provider tools (Higgsfield, MakeUGC, Zernio) point at a placeholder
 * host and stay "Provider not configured" until a seller connects a key, so nothing is faked; the
 * QuickNode tool is the real per-request x402 resource on devnet.
 *
 *   pnpm marketplace:seed               read-only plan
 *   pnpm marketplace:seed --confirm     create devnet token accounts and the catalogue rows (resumable)
 *
 * VEILO_KEYS_ROOT points at the checkout whose relative key paths (FUNDING_KEY_PATH) to use. State
 * and throwaway creator keys live under work/marketplace-seed (gitignored, 0600) and are never printed.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { address, createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes, getBase58Decoder, signBytes, type KeyPairSigner } from "@solana/kit";
import { createClient } from "@supabase/supabase-js";
import { findRepoRoot, loadConfig, loadDotEnv, verifyChainIdentity } from "@veilo/contracts";
import { MARKETPLACE_LIMITS, PROVIDER_MANIFESTS, TEST_TOKEN_LABEL, type ToolProvider, type WorkflowVersionInput } from "@veilo/contracts/marketplace";
import { createApp } from "../../services/marketplace/src/app";
import { createRpcChain } from "../../services/marketplace/src/chain";
import type { MarketplaceConfig } from "../../services/marketplace/src/config";
import { createDb } from "../../services/marketplace/src/db";
import { payoutProofMessage } from "../../services/marketplace/src/service";
import { ata, awaitTx, createAtaIdempotentIx, explorerTx, makeRpc, signAndSend, type SentTx } from "../devnet/lib";

const confirm = process.argv.includes("--confirm");
const repoRoot = findRepoRoot();
const keysRoot = process.env.VEILO_KEYS_ROOT ?? repoRoot;
loadDotEnv({ rootDir: keysRoot, allowMarketplaceSecrets: true });
const config = loadConfig(process.env, { rootDir: keysRoot });
const rpc = makeRpc(config.network.rpcUrl);
const workDir = join(repoRoot, "work", "marketplace-seed");
const statePath = join(workDir, "state.json");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Placeholder seller host for provider tools; it never resolves, so those tools can never be quoted. */
const PLACEHOLDER_PROVIDER_HOST = "https://provider-tools.demo.veilo.invalid";
const QUICKNODE = {
  origin: "https://x402.quicknode.com",
  path: "/solana-mainnet",
  payTo: "2LWbc9Mi6dRUrdEHBttoNS4udDtH1A4xwBdm1EKqcT57",
  feePayer: "CPZSjRmyfTS95UjQD8ZdeTEWbQvW9QvEXnn6aGP7yyMN",
  unit: "1000",
};

type State = Record<string, unknown> & { steps: Record<string, unknown> };
const state: State = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as State) : { steps: {} };
function save(): void {
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}
function done<T>(name: string): T | undefined {
  return state.steps[name] as T | undefined;
}
function step<T>(name: string, value: T): T {
  state.steps[name] = value;
  save();
  console.log(`✓ ${name}`);
  return value;
}

async function keyFor(name: string): Promise<KeyPairSigner> {
  const dir = join(workDir, "keys");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${name}.seed.json`);
  if (!existsSync(path)) writeFileSync(path, JSON.stringify([...randomBytes(32)]), { mode: 0o600 });
  chmodSync(path, 0o600);
  const seed = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  seed.fill(0);
  return signer;
}

const signText = async (signer: KeyPairSigner, message: string) => new Uint8Array(await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(message)));

async function session(signer: KeyPairSigner): Promise<{ token: string; userId: string }> {
  const client = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_PUBLISHABLE_KEY as string, { auth: { persistSession: false, autoRefreshToken: false } });
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
  return { token: data.session.access_token, userId: data.session.user.id };
}

interface Creator {
  key: string;
  name: string;
  description: string;
}
const CREATORS: Creator[] = [
  { key: "ledger-lab", name: "Ledger Lab (demo)", description: "Demo creator account for on-chain research workflows." },
  { key: "studio-north", name: "Studio North (demo)", description: "Demo creator account for content workflows." },
  { key: "clipworks", name: "Clipworks (demo)", description: "Demo creator account for media and social workflows; its provider tools are not connected." },
];

interface ManagedTool {
  creator: string;
  slug: string;
  title: string;
  summary: string;
  template: "research-summary" | "structured-analysis" | "content-package";
  price: string;
  sections: string[];
}
const MANAGED: ManagedTool[] = [
  { creator: "ledger-lab", slug: "demo-onchain-brief-writer", title: "On-chain brief writer (demo)", summary: "Writes a cited brief from purchased on-chain data with DeepSeek V4 Flash.", template: "research-summary", price: "20000", sections: ["Summary", "Key points", "Sources"] },
  { creator: "ledger-lab", slug: "demo-wallet-analyst", title: "Wallet activity analyst (demo)", summary: "Turns wallet balance and recent signatures into a structured analysis.", template: "structured-analysis", price: "20000", sections: ["Findings", "Risks"] },
  { creator: "studio-north", slug: "demo-content-package", title: "Content package writer (demo)", summary: "Three channel drafts and a seven-day plan from a topic or brief.", template: "content-package", price: "30000", sections: ["Drafts", "Calendar"] },
  { creator: "studio-north", slug: "demo-research-summary", title: "Topic research summary (demo)", summary: "A short research summary of a topic to brief a content writer.", template: "research-summary", price: "20000", sections: ["Summary", "Key points"] },
];

interface ProviderTool {
  creator: string;
  slug: string;
  title: string;
  summary: string;
  provider: ToolProvider;
  price: string;
}
const PROVIDERS: ProviderTool[] = [
  { creator: "clipworks", slug: "demo-higgsfield-image", title: "Higgsfield image (demo, provider not connected)", summary: "Generates an image from a prompt on the seller's own Higgsfield key. Workflow step only.", provider: "higgsfield", price: "50000" },
  { creator: "clipworks", slug: "demo-makeugc-video", title: "MakeUGC video (demo, provider not connected)", summary: "Produces a talking-actor UGC video from a script on the seller's own MakeUGC key.", provider: "makeugc", price: "100000" },
  { creator: "clipworks", slug: "demo-zernio-draft", title: "Zernio post draft (demo, provider not connected)", summary: "Creates a post draft only; nothing is published or scheduled without the owner.", provider: "zernio", price: "5000" },
];

async function main(): Promise<void> {
  console.log(`Workflow marketplace seed (demo accounts). ${TEST_TOKEN_LABEL}`);
  const identity = await verifyChainIdentity(config);
  const mint = address(config.network.mint);
  // Rent for the creators' token accounts comes from the funding wallet when present, otherwise
  // each throwaway creator key takes a small devnet faucet airdrop and pays its own rent.
  const fundingPath = process.env.FUNDING_KEY_PATH;
  const funding =
    fundingPath && existsSync(join(keysRoot, fundingPath))
      ? await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(join(keysRoot, fundingPath), "utf8")) as number[]))
      : null;
  const sol = funding ? (await rpc.getBalance(funding.address, { commitment: "finalized" }).send()).value : null;
  const creators = new Map<string, KeyPairSigner>();
  for (const c of CREATORS) creators.set(c.key, await keyFor(c.key));
  console.log(
    JSON.stringify(
      {
        genesis: identity.genesisHash,
        rentPayer: funding ? { funding: funding.address, lamports: sol?.toString() } : "devnet faucet airdrop to each throwaway creator key",
        creators: CREATORS.map((c) => ({ name: c.name, payout: creators.get(c.key)?.address })),
        managedTools: MANAGED.length,
        providerTools: PROVIDERS.length,
        externalTools: 2,
        workflows: 5,
      },
      null,
      2,
    ),
  );
  if (!confirm) {
    console.log("Read-only plan complete. Re-run with --confirm to create the creators' devnet token accounts and the catalogue rows.");
    return;
  }

  // 1. Each demo creator's payout token account must exist before its payout proof is accepted.
  for (const c of CREATORS) {
    const name = `tx.ata.${c.key}`;
    if (done(name)) continue;
    const owner = creators.get(c.key) as KeyPairSigner;
    const payer = funding ?? owner;
    if (!funding && (await rpc.getBalance(owner.address, { commitment: "confirmed" }).send()).value < 5_000_000n) {
      // Devnet faucet only; verifyChainIdentity above already refused any non-devnet RPC.
      const r = await fetch(config.network.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "requestAirdrop", params: [owner.address, 50_000_000] }) });
      const j = (await r.json()) as { error?: { message?: string } };
      if (j.error) throw new Error(`devnet airdrop refused: ${j.error.message ?? "unknown"}; fund ${owner.address} with a little devnet SOL and rerun`);
      for (let i = 0; i < 30 && (await rpc.getBalance(owner.address, { commitment: "confirmed" }).send()).value < 5_000_000n; i += 1) await new Promise((r) => setTimeout(r, 2_000));
    }
    let sent = (state.steps[`${name}.sent`] as SentTx | undefined) ?? undefined;
    if (!sent) sent = await signAndSend(rpc, payer, [], [createAtaIdempotentIx(payer.address, await ata(owner.address, mint), owner.address, mint)], (s) => step(`${name}.sent`, s));
    const outcome = await awaitTx(rpc, sent);
    if (outcome.state !== "finalized" || outcome.outcome.err) throw new Error(`${name}: ${outcome.state}; rerun to reconcile`);
    step(name, { signature: sent.signature, explorer: explorerTx(sent.signature) });
  }

  // 2. Marketplace API in process, using the configured Supabase project.
  const operatorToken = (state.operatorToken as string | undefined) ?? `op_${randomBytes(24).toString("base64url")}`;
  state.operatorToken = operatorToken;
  save();
  const marketConfig: MarketplaceConfig = {
    port: 0,
    bindHost: "127.0.0.1",
    supabaseUrl: process.env.SUPABASE_URL as string,
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY as string,
    supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY as string,
    rpcUrl: config.network.rpcUrl,
    network: config.network.caip2,
    genesisHash: identity.genesisHash,
    mint: config.network.mint,
    decimals: config.network.mintDecimals,
    sellerHostTokenHash: sha(`unused_${randomBytes(16).toString("hex")}`),
    operatorTokenHash: sha(operatorToken),
    managedSellerOrigin: process.env.MARKETPLACE_MANAGED_SELLER_ORIGIN ?? null,
    managedSellerIdentity: process.env.MARKETPLACE_MANAGED_SELLER_IDENTITY ?? "veilo-seller-host-devnet",
    devSellerOrigins: [],
    allowedBrowserOrigins: [],
    maxNetworkFeeLamports: 10_000_000n,
    quoteTtlSeconds: 300,
    termsVersion: "2026-10-17",
    managedRuntimeRevision: "v2",
  } as MarketplaceConfig;
  const server = createApp({ db: createDb(marketConfig), chain: createRpcChain(config.network.rpcUrl), config: marketConfig, now: () => new Date() }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async <T = Record<string, unknown>>(method: string, path: string, token: string | null, body?: unknown): Promise<T> => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = (await res.json().catch(() => null)) as T & { error?: { code: string; message: string }; problems?: string[] };
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json?.error?.code ?? ""} ${json?.error?.message ?? ""} ${(json?.problems ?? []).join("; ")}`);
    return json;
  };

  try {
    // 3. Creators: sign in, profile, proven payout wallet, approved seller.
    const sessions = new Map<string, { token: string; payoutVersionId: string; sellerId: string }>();
    for (const c of CREATORS) {
      const signer = creators.get(c.key) as KeyPairSigner;
      const s = await session(signer);
      await call("POST", "/me/bootstrap", s.token);
      const prior = done<{ sellerId: string; payoutVersionId: string }>(`creator.${c.key}`);
      if (prior) {
        sessions.set(c.key, { token: s.token, ...prior });
        continue;
      }
      const profile = await call<{ sellerId: string }>("POST", "/seller/profile", s.token, { publicName: c.name, description: c.description });
      const issuedAt = new Date().toISOString();
      const message = payoutProofMessage({ userId: s.userId, address: signer.address, network: marketConfig.network, mint: marketConfig.mint, issuedAt });
      const payout = await call<{ payoutVersionId: string }>("POST", "/seller/payouts", s.token, { address: signer.address, issuedAt, signature: getBase58Decoder().decode(await signText(signer, message)) });
      await call("POST", `/operator/sellers/${profile.sellerId}/status`, operatorToken, { status: "approved" });
      sessions.set(c.key, { token: s.token, ...step(`creator.${c.key}`, { sellerId: profile.sellerId, payoutVersionId: payout.payoutVersionId }) });
    }

    // 4. Tools: managed templates, provider adapters, and the real QuickNode x402 resource.
    const tool = new Map<string, { toolKind: "listing" | "external"; toolId: string; price: string }>();
    const listing = async (slug: string, creator: string, body: Record<string, unknown>, profile: Record<string, unknown> | null) => {
      const prior = done<{ versionId: string }>(`listing.${slug}`);
      if (prior) return prior.versionId;
      const s = sessions.get(creator)!;
      const l = await call<{ listingId: string }>("POST", "/seller/listings", s.token, { slug });
      const v = await call<{ versionId: string }>("POST", `/seller/listings/${l.listingId}/versions`, s.token, { ...body, payoutVersionId: s.payoutVersionId });
      if (profile) await call("POST", `/seller/versions/${v.versionId}/tool-profile`, s.token, profile);
      await call("POST", `/seller/versions/${v.versionId}/submit`, s.token);
      await call("POST", `/operator/versions/${v.versionId}/review`, operatorToken, { approve: true, note: "demo seed" });
      return step(`listing.${slug}`, { versionId: v.versionId }).versionId;
    };
    const common = { refundTerms: "Seller-funded refund if nothing is delivered (demo).", dataHandling: "Inputs are sent to the named tool provider; demo listing.", termsVersion: "2026-10-17", turnaroundMinutes: 15 };
    for (const t of MANAGED) {
      const id = await listing(t.slug, t.creator, {
        ...common,
        title: t.title,
        summary: t.summary,
        description: `${t.summary} Runs on Veilo's managed seller host with operator-funded DeepSeek V4 Flash inference. Demo listing.`,
        runtimeKind: "managed_template",
        template: t.template,
        remoteOrigin: null,
        sellerInstructions: "",
        inputSchema: { briefHint: "Topic or purchased data to work from", maxBriefChars: MARKETPLACE_LIMITS.maxBriefChars },
        outputSchema: { format: "markdown", sections: t.sections },
        priceBaseUnits: t.price,
      }, null);
      tool.set(t.slug, { toolKind: "listing", toolId: id, price: t.price });
    }
    for (const t of PROVIDERS) {
      const m = PROVIDER_MANIFESTS[t.provider].tools[0]!;
      const id = await listing(
        t.slug,
        t.creator,
        {
          ...common,
          title: t.title,
          summary: t.summary,
          description: `${t.summary} Demo listing: the seller host is a placeholder and no provider key is connected, so this tool cannot be quoted or paid.`,
          runtimeKind: "remote_endpoint",
          template: null,
          remoteOrigin: PLACEHOLDER_PROVIDER_HOST,
          sellerInstructions: "",
          inputSchema: { briefHint: m.io.inputs[0]!.name, maxBriefChars: Math.min(MARKETPLACE_LIMITS.maxBriefChars, m.io.inputs[0]!.maxChars) },
          outputSchema: { format: "markdown", sections: [] },
          priceBaseUnits: t.price,
        },
        { toolKind: "provider_adapter", provider: t.provider, toolName: m.name, effect: m.effect, io: m.io },
      );
      tool.set(t.slug, { toolKind: "listing", toolId: id, price: t.price });
    }
    const external = async (slug: string, title: string, summary: string, input: string, calls: Array<[string, unknown[]]>, methods: string[]) => {
      const prior = done<{ toolId: string; price: string }>(`external.${slug}`);
      if (prior) return prior;
      const s = sessions.get("ledger-lab")!;
      const t = await call<{ toolId: string }>("POST", "/tools/external", s.token, {
        slug,
        title,
        summary,
        origin: QUICKNODE.origin,
        resourcePath: QUICKNODE.path,
        payTo: QUICKNODE.payTo,
        payToAta: await ata(QUICKNODE.payTo, mint),
        unitPriceBaseUnits: QUICKNODE.unit,
        callsPerStep: calls.length,
        feePayers: [QUICKNODE.feePayer],
        rpcMethods: methods,
        io: { inputs: [{ name: input, kind: "text", required: true, maxChars: 64 }], output: { kind: "json" } },
        callTemplate: calls.map(([method, params], i) => ({ method: "POST", path: QUICKNODE.path, body: { jsonrpc: "2.0", id: i + 1, method, params } })),
      });
      await call("POST", `/operator/external-tools/${t.toolId}/status`, operatorToken, { status: "approved", note: "QuickNode per-request x402 on devnet; verified 2026-10-17" });
      return step(`external.${slug}`, { toolId: t.toolId, price: (BigInt(QUICKNODE.unit) * BigInt(calls.length)).toString() });
    };
    const qnMint = await external(
      "quicknode-token-snapshot",
      "QuickNode token snapshot (x402)",
      "Live Solana mainnet token supply, largest holders and mint authorities, bought per request from QuickNode x402 on devnet.",
      "mint",
      [["getTokenSupply", ["{{mint}}"]], ["getTokenLargestAccounts", ["{{mint}}"]], ["getAccountInfo", ["{{mint}}", { encoding: "jsonParsed" }]]],
      ["getTokenSupply", "getTokenLargestAccounts", "getAccountInfo"],
    );
    tool.set("qn-mint", { toolKind: "external", toolId: qnMint.toolId, price: qnMint.price });
    const qnWallet = await external(
      "quicknode-wallet-snapshot",
      "QuickNode wallet snapshot (x402)",
      "Live Solana mainnet wallet balance and recent signatures, bought per request from QuickNode x402 on devnet.",
      "wallet",
      [["getBalance", ["{{wallet}}"]], ["getSignaturesForAddress", ["{{wallet}}", { limit: 5 }]]],
      ["getBalance", "getSignaturesForAddress"],
    );
    tool.set("qn-wallet", { toolKind: "external", toolId: qnWallet.toolId, price: qnWallet.price });

    // 5. Workflows. All tools are approved, so each goes live after the automated checks.
    const step_ = (key: string, inputs: WorkflowVersionInput["steps"][number]["inputs"]) => {
      const t = tool.get(key)!;
      return { toolKind: t.toolKind, toolId: t.toolId, maxBaseUnits: t.price, inputs };
    };
    const workflow = async (creator: string, slug: string, v: Omit<WorkflowVersionInput, "payoutVersionId" | "totalMaxBaseUnits">) => {
      if (done(`workflow.${slug}`)) return;
      const s = sessions.get(creator)!;
      const total = v.steps.reduce((n, x) => n + BigInt(x.maxBaseUnits), 0n).toString();
      const w = await call<{ workflowId: string }>("POST", "/creator/workflows", s.token, { slug, category: v.category });
      const ver = await call<{ versionId: string; decision: string }>("POST", `/creator/workflows/${w.workflowId}/versions`, s.token, { ...v, totalMaxBaseUnits: total, payoutVersionId: s.payoutVersionId });
      const pub = await call<{ status: string }>("POST", `/creator/versions/${ver.versionId}/publish`, s.token);
      step(`workflow.${slug}`, { workflowId: w.workflowId, versionId: ver.versionId, status: pub.status });
    };
    await workflow("ledger-lab", "token-supply-brief", {
      category: "research",
      title: "Token supply brief",
      summary: "Buys live token supply and top holders from QuickNode, then writes a cited brief.",
      description: "Step 1 buys three read-only Solana mainnet RPC calls from QuickNode x402 (paid on devnet). Step 2 writes a brief that cites each purchased response.",
      safetyPromise: "Read-only; it never sends a transaction or posts anything.",
      runInputs: [{ name: "mint", label: "Token mint address", maxChars: 64 }],
      steps: [step_("qn-mint", { mint: { from: "run_input", name: "mint" } }), step_("demo-onchain-brief-writer", { brief: { from: "step", step: 0 } })],
      sampleOutput: null,
    });
    await workflow("ledger-lab", "wallet-activity-snapshot", {
      category: "data",
      title: "Wallet activity snapshot",
      summary: "Live balance and recent signatures for a wallet, analysed into findings and risks.",
      description: "Step 1 buys two read-only RPC calls from QuickNode x402; step 2 turns them into a structured analysis.",
      safetyPromise: "Read-only; it never sends a transaction or contacts anyone.",
      runInputs: [{ name: "wallet", label: "Wallet address", maxChars: 64 }],
      steps: [step_("qn-wallet", { wallet: { from: "run_input", name: "wallet" } }), step_("demo-wallet-analyst", { brief: { from: "step", step: 0 } })],
      sampleOutput: null,
    });
    await workflow("studio-north", "launch-content-kit", {
      category: "content",
      title: "Launch content kit",
      summary: "Researches a topic, then writes three channel drafts and a seven-day plan.",
      description: "Two managed steps on DeepSeek V4 Flash: a research summary, then a content package built from it. Drafts only.",
      safetyPromise: "Drafts only; nothing posts without your approval.",
      runInputs: [{ name: "topic", label: "Topic", maxChars: 500 }],
      steps: [step_("demo-research-summary", { brief: { from: "run_input", name: "topic" } }), step_("demo-content-package", { brief: { from: "step", step: 0 } })],
      sampleOutput: null,
    });
    await workflow("clipworks", "ugc-video-campaign", {
      category: "media",
      title: "UGC video campaign",
      summary: "Content package → Higgsfield image → MakeUGC video → Zernio draft. Provider steps are not connected in this demo.",
      description: "Shows a media chain. The content step runs today; the Higgsfield, MakeUGC and Zernio steps need a seller with those keys and stop the run before payment until then.",
      safetyPromise: "Drafts only; nothing posts without your approval of the exact content, account and time.",
      runInputs: [{ name: "topic", label: "Product or campaign", maxChars: 500 }],
      steps: [
        step_("demo-content-package", { brief: { from: "run_input", name: "topic" } }),
        step_("demo-higgsfield-image", { prompt: { from: "step", step: 0 } }),
        step_("demo-makeugc-video", { script: { from: "step", step: 0 } }),
        step_("demo-zernio-draft", { text: { from: "step", step: 0 } }),
      ],
      sampleOutput: null,
    });
    await workflow("clipworks", "social-post-drafts", {
      category: "social",
      title: "Social post drafts",
      summary: "Writes channel posts, then prepares a Zernio draft for your approval.",
      description: "A managed content step, then a Zernio draft step (not connected in this demo). Nothing is published or scheduled automatically.",
      safetyPromise: "Drafts only; nothing posts without your approval.",
      runInputs: [{ name: "topic", label: "Topic", maxChars: 500 }],
      steps: [step_("demo-content-package", { brief: { from: "run_input", name: "topic" } }), step_("demo-zernio-draft", { text: { from: "step", step: 0 } })],
      sampleOutput: null,
    });
    console.log(JSON.stringify(Object.fromEntries(Object.entries(state.steps).filter(([k]) => k.startsWith("workflow."))), null, 2));
  } finally {
    server.close();
  }
}

main().catch((error: unknown) => {
  console.error(`seed aborted: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
