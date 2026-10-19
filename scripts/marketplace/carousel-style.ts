/** Targeted catalogue update. Submits new versions for review; never approves or runs a workflow. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot, loadDotEnv } from "@veilo/contracts";
import { CAROUSEL_SLIDES, MARKETPLACE_LIMITS, PROVIDER_MANIFESTS } from "@veilo/contracts/marketplace";
import { REFERENCE_SLIDE_INPUT } from "./carousel-style-definition";
import { keyFor, web3Session } from "./web3-session";

const root = findRepoRoot();
const submit = process.argv.includes("--submit");
const preview = process.argv.includes("--preview");
const workflow = process.argv.includes("--workflow") || preview;
const slugs = ["tiktok-slide-planner", "tiktok-slide-designer"] as const;
const workflowSlug = preview ? "tiktok-carousel-reference-preview" : "tiktok-carousel-designed-publish";

async function main(): Promise<void> {
  if (!submit && !workflow) {
    console.log("Read-only plan: submit reference-style planner and renderer versions for operator review, then prepare a new public-publishing workflow version. No approvals, provider calls, payments or posts.");
    console.log("1. pnpm marketplace:carousel-style --submit\n2. Review the returned listing version IDs with marketplace:operator review\n3. pnpm marketplace:carousel-style --workflow\n4. Review the returned workflow version ID, then reassign it to your agent and approve an individual run in the website.");
    return;
  }
  if (submit && workflow) throw new Error("Use --submit and --workflow separately, with listing review between them.");
  loadDotEnv({ rootDir: root });
  const dir = join(root, "work", "marketplace-seed");
  const statePath = join(dir, "state.json");
  if (!existsSync(statePath) || !existsSync(join(dir, "keys", "studio-north.seed.json"))) throw new Error("Existing Studio North seed state and creator key are required; no new identity will be created.");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { steps: Record<string, unknown> };
  const creator = state.steps["creator.studio-north"] as { payoutVersionId: string } | undefined;
  if (!creator) throw new Error("Studio North creator state is missing.");
  const session = await web3Session(await keyFor(join(dir, "keys"), "studio-north"));
  const base = (process.env.MARKETPLACE_URL ?? "http://127.0.0.1:4106").replace(/\/$/, "");
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const result = await response.json() as T & { error?: { code?: string; message?: string }; problems?: string[] };
    if (!response.ok) throw new Error(`${path}: ${result.error?.code ?? response.status} ${result.error?.message ?? ""} ${(result.problems ?? []).join("; ")}`);
    return result;
  }
  const save = (key: string, value: unknown) => { state.steps[key] = value; writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 }); };
  const dashboard = await call<{ versions: Array<{ id: string; listing_id: string; review_status: string }> }>("GET", "/seller/dashboard");
  if (submit) {
    const { MANAGED, PROVIDERS } = await import("./seed-workflows");
    for (const slug of slugs) {
      const key = `listing.${slug}.v4`;
      let recorded = state.steps[key] as { versionId: string; profileSaved?: boolean; submitted?: boolean } | undefined;
      const prior = state.steps[`listing.${slug}`] as { versionId: string } | undefined;
      const listing = dashboard.versions.find((v) => v.id === prior?.versionId);
      if (!listing) throw new Error(`Original listing ${slug} was not found for this creator.`);
      const managed = MANAGED.find((t) => t.slug === slug);
      const provider = PROVIDERS.find((t) => t.slug === slug);
      const definition = managed ?? provider;
      if (!definition) throw new Error(`No definition for ${slug}`);
      const manifest = provider ? PROVIDER_MANIFESTS[provider.provider].tools.find((t) => t.name === provider.toolName)! : null;
      if (!recorded) {
        const created = await call<{ versionId: string }>("POST", `/seller/listings/${listing.listing_id}/versions`, {
          title: definition.title, summary: definition.summary, description: `${definition.summary} Reference-image style is a model description used for supported visual settings; exact image reproduction is not promised.`,
          runtimeKind: managed ? "managed_template" : "remote_endpoint", template: managed?.template ?? null, remoteOrigin: provider?.origin ?? null,
          sellerInstructions: managed?.sellerInstructions ?? "", inputSchema: { briefHint: managed ? "Topic, visual style and slide count" : "Slide plan and visual style", maxBriefChars: MARKETPLACE_LIMITS.maxBriefChars },
          outputSchema: { format: "markdown", sections: managed?.sections ?? [] }, priceBaseUnits: definition.price, payoutVersionId: creator.payoutVersionId,
          turnaroundMinutes: 15, refundTerms: "Seller-funded refund if nothing is delivered (demo).", dataHandling: "The local model describes the reference image; only bounded style text and the brief reach this workflow.", termsVersion: "2026-10-19-reference-style",
        });
        recorded = { versionId: created.versionId }; save(key, recorded);
      }
      if (!recorded.profileSaved) {
        await call("POST", `/seller/versions/${recorded.versionId}/tool-profile`, managed ? { toolKind: "managed_template", provider: null, toolName: null, effect: "read_only", io: managed.io } : { toolKind: "provider_adapter", provider: provider!.provider, toolName: manifest!.name, effect: manifest!.effect, io: manifest!.io });
        recorded.profileSaved = true; save(key, recorded);
      }
      if (!recorded.submitted) { await call("POST", `/seller/versions/${recorded.versionId}/submit`, {}); recorded.submitted = true; save(key, recorded); }
      console.log(`${slug}: ${recorded.versionId}\npnpm marketplace:operator review ${recorded.versionId} approve "Reviewed reference-style inputs and bounded renderer"`);
    }
    console.log("Listing versions submitted only. Review them before --workflow. No run or post was started.");
    return;
  }
  const tool = (slug: string) => {
    const row = state.steps[`listing.${slug}${slugs.includes(slug as typeof slugs[number]) ? ".v4" : ""}`] as { versionId: string } | undefined;
    if (!row || dashboard.versions.find((v) => v.id === row.versionId)?.review_status !== "approved") throw new Error(`Approve ${slug}'s current listing version first.`);
    return row.versionId;
  };
  const key = `workflow.${workflowSlug}.v4`;
  let saved = state.steps[key] as { workflowId: string; versionId: string; status?: string } | undefined;
  if (!saved) {
    const prior = state.steps[`workflow.${workflowSlug}`] as { workflowId: string } | undefined;
    if (!prior && !preview) throw new Error("Original public-publishing workflow is missing.");
    const workflowId = prior?.workflowId ?? (await call<{ workflowId: string }>("POST", "/creator/workflows", { slug: workflowSlug, category: "social" })).workflowId;
    const result = await call<{ versionId: string }>("POST", `/creator/workflows/${workflowId}/versions`, {
      title: preview ? "TikTok carousel (reference-style preview)" : "TikTok carousel (designed, posts publicly)", category: "social", summary: preview ? "Plans and renders reference-guided carousel images without a publishing step." : "Plans reference-guided slides, renders them and publishes the carousel publicly after run approval.",
      description: `The local model describes the reference image. The planner maps it to bounded colors, typography, alignment and shapes. The seller renders exact slide text${preview ? " without posting to TikTok" : " and publishes to its configured TikTok account"}. This is visual guidance, not exact image reproduction.`,
      safetyPromise: preview ? "Generates images only. This preview has no publishing step." : "Publishes publicly after run approval. No intermediate draft or editing stop; review topic, style, destination and total before approval.",
      payoutVersionId: creator.payoutVersionId, totalMaxBaseUnits: preview ? "30000" : "40000", runInputs: [{ name: "topic", label: "Topic", maxChars: 500 }, REFERENCE_SLIDE_INPUT, { name: "slides", label: `Number of slides (${CAROUSEL_SLIDES.min}–${CAROUSEL_SLIDES.max})`, maxChars: String(CAROUSEL_SLIDES.max).length }],
      steps: [
        { toolKind: "listing", toolId: tool("tiktok-slide-planner"), maxBaseUnits: "20000", inputs: { topic: { from: "run_input", name: "topic" }, style: { from: "run_input", name: "style" }, slides: { from: "run_input", name: "slides" } } },
        { toolKind: "listing", toolId: tool("tiktok-slide-designer"), maxBaseUnits: "10000", inputs: { plan: { from: "step", step: 0 } } },
        ...(!preview ? [{ toolKind: "listing", toolId: tool("zernio-tiktok-carousel-publish"), maxBaseUnits: "10000", inputs: { carousel: { from: "step", step: 1 } } }] : []),
      ], sampleOutput: null,
    });
    saved = { workflowId, versionId: result.versionId }; save(key, saved);
  }
  if (!saved.status) { const result = await call<{ status: string }>("POST", `/creator/versions/${saved.versionId}/publish`, {}); saved.status = result.status; save(key, saved); }
  console.log(`Workflow ${saved.versionId}: ${saved.status}`);
  if (saved.status !== "live") console.log(`pnpm marketplace:operator workflow-review ${saved.versionId} approve "Reviewed reference style and public publishing terms"`);
  console.log("Reassign this new workflow version to the agent before proposing a run. No payment or TikTok post was started.");
}
main().catch((error: unknown) => { console.error((error as Error).message); process.exit(1); });
