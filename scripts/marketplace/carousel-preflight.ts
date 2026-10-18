/**
 * Checks that the TikTok carousel workflow can run, without spending anything or posting.
 *
 *   pnpm marketplace:carousel-preflight
 *
 * It reads only key presence (never values) and makes two free Zernio reads: the connected
 * TikTok accounts and that account's allowed privacy levels. It never calls Higgsfield and never
 * creates a post or draft.
 */
import { findRepoRoot, loadDotEnv } from "@veilo/contracts";

const rootDir = findRepoRoot();
loadDotEnv({ rootDir });
const env = (k: string) => process.env[k]?.trim() || undefined;

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

async function zernio(path: string, key: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`https://zernio.com/api/v1${path}`, { headers: { authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(20_000) });
  return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
}

async function main(): Promise<void> {
  const hf = Boolean(env("HIGGSFIELD_API_KEY_ID") && env("HIGGSFIELD_API_KEY_SECRET"));
  const cap = Math.min(4, Math.max(2, Number(env("HIGGSFIELD_MAX_IMAGES") ?? 4) || 4));
  add("Higgsfield key", hf, hf ? `set; at most ${cap} images per run (HIGGSFIELD_MAX_IMAGES)` : "HIGGSFIELD_API_KEY_ID / HIGGSFIELD_API_KEY_SECRET missing: the image step shows \"Provider not configured\" and is never quoted or paid");

  const key = env("ZERNIO_API_KEY");
  const account = env("ZERNIO_TIKTOK_ACCOUNT_ID");
  if (!key) add("Zernio key", false, "ZERNIO_API_KEY missing");
  else {
    const r = await zernio("/accounts?platform=tiktok", key);
    const list = ((r.body as { accounts?: unknown[] } | null)?.accounts ?? (Array.isArray(r.body) ? r.body : [])) as Array<{ _id?: string; username?: string; displayName?: string; platform?: string; isActive?: boolean }>;
    add("Zernio key", r.status === 200, r.status === 200 ? "accepted" : `HTTP ${r.status} from GET /v1/accounts`);
    if (r.status === 200) {
      const tiktok = list.filter((a) => (a.platform ?? "tiktok") === "tiktok");
      add("TikTok account connected in Zernio", tiktok.length > 0, tiktok.length > 0 ? tiktok.map((a) => `${a._id} (@${a.username ?? a.displayName ?? "?"})`).join(", ") : "none: connect TikTok in Zernio first");
      if (!account) add("ZERNIO_TIKTOK_ACCOUNT_ID", false, tiktok.length === 1 ? `missing; set it to ${tiktok[0]!._id}` : "missing; set it to one of the ids above");
      else {
        const known = tiktok.some((a) => a._id === account);
        add("ZERNIO_TIKTOK_ACCOUNT_ID", known, known ? "matches a connected TikTok account" : "not among the connected TikTok accounts");
        if (known) {
          const c = await zernio(`/accounts/${encodeURIComponent(account)}/tiktok/creator-info`, key);
          // Mirrors the Zernio adapter: SELF_ONLY when offered, otherwise the first offered level; either way the post is an inbox draft.
          const body = c.body as { privacyLevels?: Array<{ value?: unknown }>; creator?: { canPostMore?: unknown } } | null;
          const levels = (Array.isArray(body?.privacyLevels) ? body.privacyLevels : []).map((l) => l.value).filter((v): v is string => typeof v === "string");
          const level = levels.includes("SELF_ONLY") ? "SELF_ONLY" : levels[0];
          const canPost = body?.creator?.canPostMore !== false;
          add(
            "TikTok draft privacy level",
            c.status === 200 && level !== undefined && canPost,
            c.status !== 200 ? `HTTP ${c.status} from creator-info` : !level ? "the account offers no privacy level" : !canPost ? "the account cannot post more right now" : `drafts use ${level} (offered: ${levels.join(", ")})`,
          );
        }
      }
    }
  }

  const origin = env("CAROUSEL_SELLER_ORIGIN");
  add("Carousel seller host origin", Boolean(origin), origin ? origin : "CAROUSEL_SELLER_ORIGIN missing: the seeded tools point at a placeholder host and cannot be paid");
  if (origin) {
    for (const k of ["MARKETPLACE_DEV_SELLER_ORIGINS", "MARKETPLACE_LOCAL_SELLER_ORIGINS"]) {
      const listed = (env(k) ?? "").split(",").map((x) => x.trim().replace(/\/$/, "")).includes(origin.replace(/\/$/, ""));
      add(k, listed, listed ? "includes the carousel host" : "must include CAROUSEL_SELLER_ORIGIN for a local (non-https) host");
    }
  }

  for (const c of checks) console.log(`${c.ok ? "ok  " : "TODO"}  ${c.name}: ${c.detail}`);
  console.log(
    [
      "",
      "Most one run can cost: 0.23 USDC on devnet (planner 0.02, images 0.20, draft 0.01) plus",
      `${cap} Higgsfield images on the seller's own Higgsfield credits; Zernio makes one TikTok inbox draft (never published).`,
      "Nothing was generated, drafted or paid by this check.",
    ].join("\n"),
  );
  process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
