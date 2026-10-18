/**
 * Seeds the workflow marketplace with demo creators, tools and workflows so the catalogue is not
 * empty. Every creator and listing is labeled demo. Managed tools run on Veilo's seller host with
 * operator-funded inference; provider tools (Higgsfield, MakeUGC, Zernio, slides) point at a placeholder
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
import { CAROUSEL_SLIDE_COUNT_RULE, CAROUSEL_SLIDES, mcpToolDigest, MARKETPLACE_LIMITS, PROVIDER_MANIFESTS, TEST_TOKEN_LABEL, type ToolIo, type ToolProvider, type WorkflowVersionInput } from "@veilo/contracts/marketplace";
import { createApp } from "../../services/marketplace/src/app";
import { createRpcChain } from "../../services/marketplace/src/chain";
import type { MarketplaceConfig } from "../../services/marketplace/src/config";
import { createDb } from "../../services/marketplace/src/db";
import { payoutProofMessage } from "../../services/marketplace/src/service";
import { McpClient } from "@veilo/mcp-client";
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
  sellerInstructions?: string;
  /** Named inputs, each passed to the template as its own brief section; one "brief" input when omitted. */
  io?: ToolIo;
  /** Set when the published text changed: a seeded listing gets a new version under listing.<slug>.v<revision>. */
  revision?: number;
}
const NUMBERED_SLIDES = CAROUSEL_SLIDE_COUNT_RULE;
const SLIDE_RANGE = `${CAROUSEL_SLIDES.min} to ${CAROUSEL_SLIDES.max}`;
const MANAGED: ManagedTool[] = [
  { creator: "ledger-lab", slug: "demo-onchain-brief-writer", title: "On-chain brief writer (demo)", summary: "Writes a cited brief from purchased on-chain data with DeepSeek V4 Flash.", template: "research-summary", price: "20000", sections: ["Summary", "Key points", "Sources"] },
  { creator: "ledger-lab", slug: "demo-wallet-analyst", title: "Wallet activity analyst (demo)", summary: "Turns wallet balance and recent signatures into a structured analysis.", template: "structured-analysis", price: "20000", sections: ["Findings", "Risks"] },
  { creator: "studio-north", slug: "demo-content-package", title: "Content package writer (demo)", summary: "Three channel drafts and a seven-day plan from a topic or brief.", template: "content-package", price: "30000", sections: ["Drafts", "Calendar"] },
  { creator: "studio-north", slug: "demo-research-summary", title: "Topic research summary (demo)", summary: "A short research summary of a topic to brief a content writer.", template: "research-summary", price: "20000", sections: ["Summary", "Key points"] },
  {
    creator: "studio-north",
    slug: "tiktok-carousel-planner",
    title: "TikTok carousel planner",
    summary: "Turns a topic into four image prompts and a caption for a TikTok photo carousel.",
    template: "content-package",
    price: "20000",
    sections: ["Slides", "Caption"],
    sellerInstructions: [
      "Under Slides write exactly four lines, each in the form \"Slide N: <prompt>\".",
      "Each prompt describes one vertical 9:16 photo for an image model: subject, setting, light and style. No text, logos or real people's names in the image.",
      "Under Caption write one TikTok caption under 300 characters with at most five hashtags.",
    ].join(" "),
  },
  {
    creator: "studio-north",
    slug: "tiktok-photo-edit-planner",
    title: "TikTok ad edit planner",
    summary: "Turns a product brief into three photo-edit instructions and a caption for a TikTok ad carousel.",
    template: "content-package",
    price: "20000",
    sections: ["Slides", "Caption"],
    sellerInstructions: [
      "Under Slides write exactly three lines, each in the form \"Slide N: <edit instruction>\".",
      "Each instruction restages the owner's own product photo for a vertical 9:16 ad: keep the product exactly as it is and change the scene, light and mood (for example a sunlit cafe table, a clean studio, an outdoor lifestyle shot). No added text, logos or real people's names.",
      "Under Caption write one TikTok caption under 300 characters with at most five hashtags.",
    ].join(" "),
  },
  {
    creator: "studio-north",
    slug: "tiktok-carousel-planner-styled",
    title: "TikTok carousel planner (style and slide count)",
    summary: `Turns a topic, a visual style and a slide count (${SLIDE_RANGE}) into image prompts and a caption for a TikTok photo carousel.`,
    template: "content-package",
    price: "20000",
    revision: 2,
    sections: ["Slides", "Caption"],
    io: {
      inputs: [
        { name: "topic", kind: "text", required: true, maxChars: 500 },
        { name: "style", kind: "text", required: true, maxChars: 200 },
        { name: "slides", kind: "text", required: true, maxChars: String(CAROUSEL_SLIDES.max).length },
      ],
      output: { kind: "markdown" },
    },
    sellerInstructions: [
      "The buyer brief has three sections: topic, style and slides.",
      `Under Slides write exactly N lines, each in the form "Slide N: <prompt>". ${NUMBERED_SLIDES}`,
      "Slide 1 is the hook and the last slide is the takeaway; each slide carries one idea that builds on the one before.",
      "Each prompt describes one vertical 9:16 image for an image model: subject, setting, light and the visual style from the style section, applied the same way on every slide.",
      "When the style section says default, use: minimal charcoal editorial, terracotta accent, soft daylight.",
      "No text, letters, logos or real people's names in any image.",
      "Under Caption write one TikTok caption under 300 characters with at most five hashtags.",
    ].join(" "),
  },
  {
    creator: "studio-north",
    slug: "tiktok-slide-planner",
    title: "TikTok slide planner (designed slides)",
    summary: `Turns a topic and a slide count (${SLIDE_RANGE}) into headline, accent and supporting text for each designed TikTok slide, plus a caption.`,
    template: "content-package",
    price: "20000",
    revision: 2,
    sections: ["Slides", "Caption"],
    io: {
      inputs: [
        { name: "topic", kind: "text", required: true, maxChars: 500 },
        { name: "slides", kind: "text", required: true, maxChars: String(CAROUSEL_SLIDES.max).length },
      ],
      output: { kind: "markdown" },
    },
    sellerInstructions: [
      "The buyer brief has two sections: topic and slides.",
      'Under Slides write only one JSON object inside a ```json fence: {"slides": [...], "caption": "..."} with exactly N slides.',
      NUMBERED_SLIDES,
      'Each slide is {"label", "headline", "accent", "body"}: label is one to three lowercase words naming the slide\'s role (for example hook, the problem, repo, verdict) with no number;',
      "headline is at most 60 characters, punchy and lowercase; accent is one or two words copied exactly from the headline to highlight; body is one supporting sentence under 140 characters.",
      "Slide 1 is the hook and the last slide is the takeaway or a call to follow.",
      'Only for a slide about a specific GitHub repository named in the brief, add "card": {"owner", "repo", "description", "language"}; add "stars" only when the brief states the star count and "score" (1 to 10) only when the brief gives one.',
      "Never invent repositories, numbers, quotes or image URLs.",
      'The JSON "caption" and the text under Caption are the same TikTok caption: under 300 characters with at most five hashtags.',
    ].join(" "),
  },
];

interface ProviderTool {
  creator: string;
  slug: string;
  title: string;
  summary: string;
  provider: ToolProvider;
  price: string;
  /** Manifest tool to sell; the first one when omitted. */
  toolName?: string;
  /** The seller host that runs it; the placeholder host when it is not configured. */
  origin?: string;
  /** Set when the published text changed: a seeded listing gets a new version under listing.<slug>.v<revision>. */
  revision?: number;
}
// The carousel tools run on the content creator's own seller host, which holds its Higgsfield and Zernio keys.
const CAROUSEL_HOST = process.env.CAROUSEL_SELLER_ORIGIN?.trim() || PLACEHOLDER_PROVIDER_HOST;
const PROVIDERS: ProviderTool[] = [
  { creator: "clipworks", slug: "demo-higgsfield-image", title: "Higgsfield image (demo, provider not connected)", summary: "Generates an image from a prompt on the seller's own Higgsfield key. Workflow step only.", provider: "higgsfield", price: "50000" },
  { creator: "clipworks", slug: "demo-makeugc-video", title: "MakeUGC video (demo, provider not connected)", summary: "Produces a talking-actor UGC video from a script on the seller's own MakeUGC key.", provider: "makeugc", price: "100000" },
  { creator: "clipworks", slug: "demo-zernio-draft", title: "Zernio post draft (demo, provider not connected)", summary: "Creates a post draft only; nothing is published or scheduled without the owner.", provider: "zernio", price: "5000" },
  {
    creator: "studio-north",
    slug: "higgsfield-carousel-images",
    title: "Higgsfield carousel images",
    summary: "Generates two to eight vertical images from \"Slide N:\" prompts with Higgsfield Soul, up to the seller's image cap. Workflow step only.",
    provider: "higgsfield",
    toolName: "generate_carousel_images",
    price: "200000",
    origin: CAROUSEL_HOST,
    revision: 2,
  },
  {
    creator: "studio-north",
    slug: "higgsfield-photo-edits",
    title: "Higgsfield product photo edits",
    summary: "Restages one product photo into two or three vertical ad shots with Higgsfield Marketing Studio. Workflow step only.",
    provider: "higgsfield",
    toolName: "edit_carousel_images",
    price: "150000",
    origin: CAROUSEL_HOST,
  },
  {
    creator: "studio-north",
    slug: "zernio-tiktok-carousel-draft",
    title: "TikTok carousel draft (Zernio)",
    summary: "Sends images and a caption to the creator's TikTok inbox as a private photo draft. It never publishes.",
    provider: "zernio",
    toolName: "create_tiktok_carousel_draft",
    price: "10000",
    origin: CAROUSEL_HOST,
  },
  {
    creator: "studio-north",
    slug: "tiktok-slide-designer",
    title: "TikTok slide designer",
    summary: `Renders ${SLIDE_RANGE} designed 1080x1920 slides (dark panel, terracotta accent, optional repo card) from a JSON slide plan and hosts them for posting. Workflow step only.`,
    provider: "slides",
    toolName: "render_carousel_slides",
    price: "10000",
    origin: CAROUSEL_HOST,
    revision: 2,
  },
  {
    creator: "studio-north",
    slug: "zernio-tiktok-carousel-publish",
    title: "TikTok carousel publish (Zernio)",
    summary: "Publishes slides rendered by the same seller host publicly to the creator's TikTok account at once. There is no draft or review step. Workflow step only.",
    provider: "zernio_publish",
    toolName: "publish_tiktok_carousel",
    price: "10000",
    origin: CAROUSEL_HOST,
  },
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
        workflows: "8; 3 to 8 slide versions of tiktok-carousel-from-topic and both designed carousels",
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
    devSellerOrigins: (process.env.MARKETPLACE_DEV_SELLER_ORIGINS ?? "").split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean),
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
    // A revision adds a reviewed version to a listing seeded earlier; the earlier steps are left as recorded.
    const listing = async (slug: string, creator: string, body: Record<string, unknown>, profile: Record<string, unknown> | null, revision?: number) => {
      const key = revision ? `listing.${slug}.v${revision}` : `listing.${slug}`;
      const recorded = done<{ versionId: string }>(key);
      if (recorded) return recorded.versionId;
      const s = sessions.get(creator)!;
      const prior = done<{ versionId: string }>(`listing.${slug}`);
      let listingId: string;
      if (prior) {
        const mine = await call<{ versions: Array<{ id: string; listing_id: string }> }>("GET", "/seller/dashboard", s.token);
        const found = mine.versions.find((x) => x.id === prior.versionId);
        if (!found) throw new Error(`${key}: seeded version of ${slug} not found for ${creator}`);
        listingId = found.listing_id;
      } else {
        listingId = (await call<{ listingId: string }>("POST", "/seller/listings", s.token, { slug })).listingId;
      }
      const v = await call<{ versionId: string }>("POST", `/seller/listings/${listingId}/versions`, s.token, { ...body, payoutVersionId: s.payoutVersionId });
      if (profile) await call("POST", `/seller/versions/${v.versionId}/tool-profile`, s.token, profile);
      await call("POST", `/seller/versions/${v.versionId}/submit`, s.token);
      await call("POST", `/operator/versions/${v.versionId}/review`, operatorToken, { approve: true, note: "demo seed" });
      if (!prior) step(`listing.${slug}`, { versionId: v.versionId });
      return key === `listing.${slug}` ? v.versionId : step(key, { versionId: v.versionId }).versionId;
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
        sellerInstructions: t.sellerInstructions ?? "",
        inputSchema: { briefHint: "Topic or purchased data to work from", maxBriefChars: MARKETPLACE_LIMITS.maxBriefChars },
        outputSchema: { format: "markdown", sections: t.sections },
        priceBaseUnits: t.price,
      }, t.io ? { toolKind: "managed_template", provider: null, toolName: null, effect: "read_only", io: t.io } : null, t.revision);
      tool.set(t.slug, { toolKind: "listing", toolId: id, price: t.price });
    }
    for (const t of PROVIDERS) {
      const m = PROVIDER_MANIFESTS[t.provider].tools.find((x) => x.name === (t.toolName ?? PROVIDER_MANIFESTS[t.provider].tools[0]!.name))!;
      const host = t.origin ?? PLACEHOLDER_PROVIDER_HOST;
      const id = await listing(
        t.slug,
        t.creator,
        {
          ...common,
          title: t.title,
          summary: t.summary,
          description:
            host === PLACEHOLDER_PROVIDER_HOST
              ? `${t.summary} Demo listing: the seller host is a placeholder and no provider key is connected, so this tool cannot be quoted or paid.`
              : `${t.summary} Runs on the seller's own host with the seller's own provider key.`,
          runtimeKind: "remote_endpoint",
          template: null,
          remoteOrigin: host,
          sellerInstructions: "",
          inputSchema: { briefHint: m.io.inputs[0]!.name, maxBriefChars: Math.min(MARKETPLACE_LIMITS.maxBriefChars, m.io.inputs[0]!.maxChars) },
          outputSchema: { format: "markdown", sections: [] },
          priceBaseUnits: t.price,
        },
        { toolKind: "provider_adapter", provider: t.provider, toolName: m.name, effect: m.effect, io: m.io },
        t.revision,
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

    // 4b. Remote MCP connectors: only tools that read public documentation are proposed, pinned
    // to the live tools/list read now, and approved only when the digests still match.
    const CONNECTORS = [
      { id: "solana-developer-docs", title: "Solana Developer MCP (docs)", endpoint: "https://mcp.solana.com/mcp", tools: ["Solana_Documentation_Search", "get_documentation", "list_sections"] },
      { id: "meteora-docs", title: "Meteora docs MCP", endpoint: "https://docs.meteora.ag/mcp", tools: ["search_meteora_documentation"] },
      { id: "coingecko-docs", title: "CoinGecko MCP (docs search)", endpoint: "https://mcp.api.coingecko.com/mcp", tools: ["search_docs"] },
    ];
    for (const c of CONNECTORS) {
      if (done(`connector.${c.id}`)) continue;
      const client = new McpClient(c.endpoint, { timeoutMs: 20_000, maxBytes: 4_000_000, publicOnly: true });
      await client.initialize();
      const live = (await client.listTools()).filter((t) => c.tools.includes(t.name));
      if (live.length !== c.tools.length) throw new Error(`${c.id}: expected tools ${c.tools.join(", ")} not all offered`);
      await call("POST", "/tools/connectors", sessions.get("ledger-lab")!.token, { id: c.id, title: c.title, endpoint: c.endpoint, tools: live });
      const recheck = new Map((await client.listTools()).map((t) => [t.name, mcpToolDigest(t)]));
      if (!live.every((t) => recheck.get(t.name) === mcpToolDigest(t))) throw new Error(`${c.id}: tools changed during review; not approved`);
      await call("POST", `/operator/connectors/${c.id}/review`, operatorToken, { approve: true, note: "read-only documentation tools; digests verified against the live tools/list" });
      step(`connector.${c.id}`, { tools: live.map((t) => ({ name: t.name, sha256: mcpToolDigest(t) })) });
    }

    // 5. Workflows. All tools are approved, so each goes live after the automated checks.
    const step_ = (key: string, inputs: WorkflowVersionInput["steps"][number]["inputs"]) => {
      const t = tool.get(key)!;
      return { toolKind: t.toolKind, toolId: t.toolId, maxBaseUnits: t.price, inputs };
    };
    /**
     * Creates a workflow, or, when `key` names a later version of one seeded earlier, publishes that
     * version on it. Each version is recorded under its own state key.
     */
    const workflow = async (creator: string, slug: string, v: Omit<WorkflowVersionInput, "payoutVersionId" | "totalMaxBaseUnits">, key = `workflow.${slug}`) => {
      if (done(key)) return;
      const s = sessions.get(creator)!;
      const total = v.steps.reduce((n, x) => n + BigInt(x.maxBaseUnits), 0n).toString();
      const prior = done<{ workflowId: string }>(`workflow.${slug}`);
      const workflowId = prior?.workflowId ?? (await call<{ workflowId: string }>("POST", "/creator/workflows", s.token, { slug, category: v.category })).workflowId;
      const ver = await call<{ versionId: string; decision: string }>("POST", `/creator/workflows/${workflowId}/versions`, s.token, { ...v, totalMaxBaseUnits: total, payoutVersionId: s.payoutVersionId });
      const pub = await call<{ status: string }>("POST", `/creator/versions/${ver.versionId}/publish`, s.token);
      const row = { workflowId, versionId: ver.versionId, status: pub.status };
      if (!prior) step(`workflow.${slug}`, row);
      if (key !== `workflow.${slug}`) step(key, row);
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
    await workflow("studio-north", "tiktok-carousel-from-topic", {
      category: "social",
      title: "TikTok carousel from a topic",
      summary: "DeepSeek plans four slides and a caption, Higgsfield makes the images, Zernio puts a photo draft in your TikTok inbox.",
      description:
        "Step 1 writes four image prompts and a caption with DeepSeek V4 Flash. Step 2 generates the vertical images with Higgsfield Soul on the seller's key. Step 3 sends them to the seller's TikTok inbox as a private draft through Zernio; a person publishes it in the TikTok app.",
      safetyPromise: "Draft only: the carousel lands in a TikTok inbox as a private draft and is never published by this workflow.",
      runInputs: [{ name: "topic", label: "Topic", maxChars: 500 }],
      steps: [
        step_("tiktok-carousel-planner", { brief: { from: "run_input", name: "topic" } }),
        step_("higgsfield-carousel-images", { slides: { from: "step", step: 0 } }),
        step_("zernio-tiktok-carousel-draft", { carousel: { from: "step", step: 1 } }),
      ],
      sampleOutput: null,
    });
    // State key v2 recorded the earlier 5 to 7 slide version; v3 replaces it with 3 to 8.
    await workflow("studio-north", "tiktok-carousel-from-topic", {
      category: "social",
      title: "TikTok carousel from a topic",
      summary: `DeepSeek plans ${SLIDE_RANGE} slides in your visual style, Higgsfield makes the images, Zernio puts a photo draft in your TikTok inbox.`,
      description:
        `Step 1 writes one image prompt per slide (${SLIDE_RANGE}, in the style you give) and a caption with DeepSeek V4 Flash. Step 2 generates the vertical images with Higgsfield Soul on the seller's key, up to the seller's image cap. Step 3 sends them to the seller's TikTok inbox as a private draft through Zernio; a person publishes it in the TikTok app.`,
      safetyPromise: "Draft only: the carousel lands in a TikTok inbox as a private draft and is never published by this workflow.",
      runInputs: [
        { name: "topic", label: "Topic", maxChars: 500 },
        { name: "style", label: "Visual style (or \"default\")", maxChars: 200 },
        { name: "slides", label: `Number of slides (${SLIDE_RANGE})`, maxChars: String(CAROUSEL_SLIDES.max).length },
      ],
      steps: [
        step_("tiktok-carousel-planner-styled", { topic: { from: "run_input", name: "topic" }, style: { from: "run_input", name: "style" }, slides: { from: "run_input", name: "slides" } }),
        step_("higgsfield-carousel-images", { slides: { from: "step", step: 0 } }),
        step_("zernio-tiktok-carousel-draft", { carousel: { from: "step", step: 1 } }),
      ],
      sampleOutput: null,
    }, "workflow.tiktok-carousel-from-topic.v3");
    await workflow("studio-north", "tiktok-carousel-designed", {
      category: "social",
      title: "TikTok carousel (designed slides)",
      summary: `DeepSeek writes ${SLIDE_RANGE} slides, the slide designer renders them in Studio North's style, Zernio puts a photo draft in your TikTok inbox.`,
      description:
        "Step 1 writes each slide's label, headline, accent word and supporting line (plus a repo card for a GitHub repository named in your topic) and a caption with DeepSeek V4 Flash. Step 2 renders 1080x1920 slides from a fixed template on the seller's host, so the text is exact, and hosts them through Zernio media. Step 3 sends them to the seller's TikTok inbox as a private draft; a person publishes it in the TikTok app.",
      safetyPromise: "Draft only: the slides land in a TikTok inbox as a private draft and are never published by this workflow.",
      runInputs: [
        { name: "topic", label: "Topic", maxChars: 500 },
        { name: "slides", label: `Number of slides (${SLIDE_RANGE})`, maxChars: String(CAROUSEL_SLIDES.max).length },
      ],
      steps: [
        step_("tiktok-slide-planner", { topic: { from: "run_input", name: "topic" }, slides: { from: "run_input", name: "slides" } }),
        step_("tiktok-slide-designer", { plan: { from: "step", step: 0 } }),
        step_("zernio-tiktok-carousel-draft", { carousel: { from: "step", step: 1 } }),
      ],
      sampleOutput: null,
    }, "workflow.tiktok-carousel-designed.v2");
    await workflow("studio-north", "tiktok-carousel-designed-publish", {
      category: "social",
      title: "TikTok carousel (designed, posts publicly)",
      summary: `DeepSeek writes ${SLIDE_RANGE} slides, the slide designer renders them, and Zernio publishes the carousel publicly on the creator's TikTok at once.`,
      description:
        "Step 1 writes each slide's text and a caption with DeepSeek V4 Flash. Step 2 renders 1080x1920 slides from a fixed template on the seller's host and hosts them through Zernio media. Step 3 publishes them publicly to the seller's TikTok account through Zernio straight away: there is no draft and no review after you approve the run. The seller host refuses to publish unless its owner turned public posting on, and posts only slides it rendered itself.",
      safetyPromise: "Publishes publicly to the creator's TikTok at once after you approve the run; there is no draft or review step.",
      runInputs: [
        { name: "topic", label: "Topic", maxChars: 500 },
        { name: "slides", label: `Number of slides (${SLIDE_RANGE})`, maxChars: String(CAROUSEL_SLIDES.max).length },
      ],
      steps: [
        step_("tiktok-slide-planner", { topic: { from: "run_input", name: "topic" }, slides: { from: "run_input", name: "slides" } }),
        step_("tiktok-slide-designer", { plan: { from: "step", step: 0 } }),
        step_("zernio-tiktok-carousel-publish", { carousel: { from: "step", step: 1 } }),
      ],
      sampleOutput: null,
    }, "workflow.tiktok-carousel-designed-publish.v2");
    await workflow("studio-north", "tiktok-ad-from-photo", {
      category: "social",
      title: "TikTok ad from your product photo",
      summary: "DeepSeek plans three ad scenes, Higgsfield restages your photo into them, Zernio puts the carousel draft in your TikTok inbox.",
      description:
        "Step 1 writes three edit instructions and a caption with DeepSeek V4 Flash. Step 2 edits your photo into each scene with Higgsfield Marketing Studio on the seller's key. Step 3 sends the carousel to the seller's TikTok inbox as a private draft through Zernio; a person publishes it in the TikTok app.",
      safetyPromise: "Draft only: the carousel lands in a TikTok inbox as a private draft and is never published by this workflow.",
      runInputs: [
        { name: "brief", label: "Product and campaign", maxChars: 500 },
        { name: "photo", label: "Product photo URL (https)", maxChars: 2048 },
      ],
      steps: [
        step_("tiktok-photo-edit-planner", { brief: { from: "run_input", name: "brief" } }),
        step_("higgsfield-photo-edits", { slides: { from: "step", step: 0 }, photo: { from: "run_input", name: "photo" } }),
        step_("zernio-tiktok-carousel-draft", { carousel: { from: "step", step: 1 } }),
      ],
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
