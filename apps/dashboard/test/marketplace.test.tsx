// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FINANCIAL_STATES, JOB_STATES, TEST_TOKEN_LABEL as SERVER_TEST_TOKEN_LABEL } from "@veilo/contracts/marketplace";
import { payoutProofMessage as serverPayoutProofMessage } from "../../../services/marketplace/src/service";
import { JobDetail } from "../components/market/JobDetail";
import { ListingDetail } from "../components/market/ListingDetail";
import { MarketContextProvider, type MarketContextValue } from "../components/market/MarketContext";
import { JobStates } from "../components/market/parts";
import { ApiError } from "../lib/api";
import { formatUnits, parseUnits, toBaseUnits } from "../lib/market/amounts";
import { SubmissionKey } from "../lib/market/idempotency";
import { presentJob } from "../lib/market/job-state";
import { payoutProofMessage, SIGN_IN_STATEMENT, TEST_TOKEN_LABEL } from "../lib/market/messages";
import type { CatalogEntry, JobDetail as JobDetailData, MeResponse, QuoteFields } from "../lib/market/types";

vi.mock("next/navigation", () => ({ usePathname: () => "/marketplace", useParams: () => ({}) }));

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  NEXT_PUBLIC_MARKETPLACE_URL: "http://127.0.0.1:4106",
};

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const HOSTILE = `<img src=x onerror="alert(1)"><script>window.__pwned = 1</script><b>bold</b>`;
const BUYER_WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SELLER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LISTING = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const VERSION = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const RECIPIENT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

const me: MeResponse = {
  userId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  address: "Owner1111111111111111111111111111111111111",
  workspace: { id: BUYER_WS, status: "active", controller_key: null, controller_key_id: null, controller_registered_at: null, controller_last_seen_at: null },
  wallets: [{ address: "Owner1111111111111111111111111111111111111", chain: "solana", verified_at: "2026-10-17T00:00:00Z" }],
  seller: null,
};

function marketValue(call: MarketContextValue["call"], extra: Partial<MarketContextValue> = {}): MarketContextValue {
  return {
    configured: true,
    ready: true,
    me,
    meError: undefined,
    reloadMe: async () => undefined,
    wallet: null,
    mismatch: null,
    canAct: true,
    token: { network: NETWORK, mint: MINT, decimals: 6 },
    tokenError: undefined,
    signIn: async () => undefined,
    signOut: async () => undefined,
    disconnectWallet: async () => undefined,
    connectWallet: async () => undefined,
    call,
    accessToken: async () => "token",
    ...extra,
  };
}

const withMarket = (value: MarketContextValue, node: ReactNode) => <MarketContextProvider value={value}>{node}</MarketContextProvider>;

function listing(extra: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    listing_id: LISTING,
    listing_version_id: VERSION,
    slug: "research-desk",
    seller_name: "Desk",
    title: "Research desk",
    summary: "Summaries",
    description: HOSTILE,
    runtime_kind: "managed_template",
    template: "research-summary",
    price_base_units: 1_500_000,
    fee_bps: 0,
    network: NETWORK,
    mint: MINT,
    decimals: 6,
    recipient: RECIPIENT,
    turnaround_minutes: 30,
    refund_terms: HOSTILE,
    data_handling: HOSTILE,
    input_hint: HOSTILE,
    output_format: "markdown",
    published_at: "2026-10-17T00:00:00Z",
    ...extra,
  };
}

describe("base-unit amounts", () => {
  it("round-trips decimal input and exact formatting without floats", () => {
    const cases: Array<[string, number, string]> = [
      ["0", 6, "0"],
      ["1", 6, "1000000"],
      ["1.5", 6, "1500000"],
      ["0.000001", 6, "1"],
      [".25", 6, "250000"],
      ["12345678.123456", 6, "12345678123456"],
      ["7", 0, "7"],
      ["0.000000000000000001", 18, "1"],
      ["99999999999999.999999", 6, "99999999999999999999"],
    ];
    for (const [text, decimals, base] of cases) {
      expect(parseUnits(text, decimals)).toEqual({ ok: true, value: base });
      expect(parseUnits(formatUnits(base, decimals)!.replace(/,/g, ""), decimals)).toEqual({ ok: true, value: base });
    }
    expect(formatUnits("1500000", 6)).toBe("1.5");
    expect(formatUnits("1234567000000", 6)).toBe("1,234,567");
    expect(formatUnits("99999999999999999999", 6)).toBe("99,999,999,999,999.999999");
  });

  it("rejects more decimals than the mint allows and malformed input", () => {
    expect(parseUnits("1.0000001", 6)).toMatchObject({ ok: false, error: "at most 6 decimal places for this token" });
    expect(parseUnits("1.5", 0)).toMatchObject({ ok: false });
    for (const bad of ["", "-1", "1e3", "1,000", "1.2.3", "0x10", " . ", "NaN", "１"]) expect(parseUnits(bad, 6).ok).toBe(false);
    expect(parseUnits("100000000000000", 6)).toMatchObject({ ok: false, error: "amount is too large" });
    expect(parseUnits("1", Number.NaN)).toMatchObject({ ok: false });
  });

  it("accepts API numbers only while they are exact", () => {
    expect(toBaseUnits(1_500_000)).toBe("1500000");
    expect(toBaseUnits("0012")).toBeNull();
    expect(toBaseUnits(2 ** 53)).toBeNull();
    expect(toBaseUnits(1.5)).toBeNull();
    expect(toBaseUnits(-1)).toBeNull();
    expect(formatUnits(2 ** 60, 6)).toBeNull();
  });
});

describe("strings shared with the marketplace service", () => {
  it("builds the payout proof message byte for byte like the server", () => {
    const p = {
      userId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      address: RECIPIENT,
      network: NETWORK,
      mint: MINT,
      issuedAt: "2026-10-17T08:30:00.000Z",
    };
    const ours = new TextEncoder().encode(payoutProofMessage(p));
    const theirs = new TextEncoder().encode(serverPayoutProofMessage(p));
    expect(Buffer.from(ours).equals(Buffer.from(theirs))).toBe(true);
  });

  it("uses the server's test-token label and a single-line login statement", () => {
    expect(TEST_TOKEN_LABEL).toBe(SERVER_TEST_TOKEN_LABEL);
    expect(SIGN_IN_STATEMENT).toBe("Sign in to Veilo marketplace. This is a login message, not a transaction or spending approval.");
    expect(SIGN_IN_STATEMENT).not.toMatch(/[\r\n]/);
  });
});

describe("hire idempotency", () => {
  it("keeps one key across retries of the same submission and starts fresh otherwise", () => {
    let n = 0;
    const keys = new SubmissionKey(() => `key-${++n}`);
    expect(keys.keyFor("listing\nbrief")).toBe("key-1");
    expect(keys.keyFor("listing\nbrief")).toBe("key-1");
    expect(keys.keyFor("listing\nother brief")).toBe("key-2");
    keys.settle();
    expect(keys.keyFor("listing\nother brief")).toBe("key-3");
  });

  it("resends the same idempotency key when the first hire request fails", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", async () => Response.json({ listing: listing({ description: "plain" }), samples: [] }));
    const quote = {
      id: "11111111-1111-4111-8111-111111111111",
      operationId: `mkt_${JOB}`,
      buyerWorkspaceId: BUYER_WS,
      jobId: JOB,
      listingVersionId: VERSION,
      runtimeVersion: "managed:research-summary:v1",
      inputDigest: "0".repeat(64),
      network: NETWORK,
      genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      mint: MINT,
      decimals: 6,
      recipient: RECIPIENT,
      recipientAta: RECIPIENT,
      sellerOrigin: "https://seller.example.com",
      sellerIdentity: "veilo-seller-host-devnet",
      baseUnits: "1500000",
      feeBps: 0,
      feeUnits: "0",
      totalUnits: "1500000",
      maxNetworkFeeLamports: "10000000",
      termsVersion: "1",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      quoteDigest: "a".repeat(64),
    };
    const bodies: Array<{ idempotencyKey: string }> = [];
    let attempt = 0;
    const call = vi.fn(async (path: string, init?: { body?: unknown }) => {
      if (path === "/jobs") {
        bodies.push(init?.body as { idempotencyKey: string });
        if (++attempt === 1) throw new ApiError(503, "PROVIDER_UNAVAILABLE", "lost reply");
        return { jobId: JOB, existing: true, quote };
      }
      return {};
    }) as unknown as MarketContextValue["call"];
    render(withMarket(marketValue(call), <ListingDetail slug="research-desk" />));
    await user.type(await screen.findByLabelText("Brief *"), "Summarize devnet fees");
    await user.click(screen.getByRole("button", { name: "Request quote" }));
    expect(await screen.findByText(/lost reply/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Request quote" }));
    expect(await screen.findByText("Immutable quote")).toBeTruthy();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.idempotencyKey).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(bodies[1]!.idempotencyKey).toBe(bodies[0]!.idempotencyKey);
    expect(screen.getByText(/local controller/, { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("a".repeat(64))).toBeTruthy();
  });

  it("refuses to offer approval for a quote that disagrees with the listing", async () => {
    const { quoteProblems } = await import("../components/market/ListingDetail");
    const l = listing();
    const ok = { listingVersionId: VERSION, recipient: RECIPIENT, mint: MINT, network: NETWORK, decimals: 6, baseUnits: "1500000", feeBps: 0, feeUnits: "0", totalUnits: "1500000" };
    expect(quoteProblems(ok as never, l)).toEqual([]);
    expect(quoteProblems({ ...ok, recipient: MINT } as never, l)).toContain("recipient differs from the listing");
    expect(quoteProblems({ ...ok, feeUnits: "1", totalUnits: "1500001" } as never, l)).toContain("quote carries a platform fee");
  });
});

describe("job state presenter", () => {
  it("never merges execution and payment into one indicator", () => {
    for (const state of JOB_STATES) {
      for (const financial of FINANCIAL_STATES) {
        const p = presentJob({ state, financial_state: financial });
        expect(p.execution.axis).toBe("Execution");
        expect(p.financial.axis).toBe("Payment");
        expect(p.execution.text).not.toMatch(/\b(paid|settled|refund)/i);
        expect(p.financial.text).not.toMatch(/deliver|succeed|running|queued/i);
        expect(p.execution.text).not.toMatch(/^Unknown/);
        expect(p.financial.text).not.toMatch(/^Unknown/);
      }
    }
  });

  it("shows a settled but failed job as paid and failed with a refund path", () => {
    const p = presentJob({ state: "failed", financial_state: "settled" });
    expect(p.execution).toMatchObject({ text: "Failed", tone: "problem" });
    expect(p.financial).toMatchObject({ text: "Paid — settled on chain", tone: "ok" });
    expect(p.paid).toBe(true);
    expect(p.paidWithoutResult).toBe(true);
    expect(p.notes.join(" ")).toMatch(/Paid; result unavailable.*refund/);
  });

  it("does not call a delivered job paid, nor an uncertain payment failed", () => {
    const delivered = presentJob({ state: "succeeded", financial_state: "settlement_uncertain" });
    expect(delivered.execution.tone).toBe("ok");
    expect(delivered.financial.tone).toBe("wait");
    expect(delivered.paid).toBe(false);
    expect(delivered.live).toBe(true);
    expect(presentJob({ state: "succeeded", financial_state: "settled" }).live).toBe(false);
    expect(presentJob({ state: "running", financial_state: "settled" }).live).toBe(true);
  });

  it("renders the two indicators as separate list items", () => {
    render(<JobStates p={presentJob({ state: "failed", financial_state: "settled" })} />);
    const items = within(screen.getByRole("list", { name: "Execution and payment states" })).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([expect.stringContaining("Failed"), expect.stringContaining("Paid — settled on chain")]);
  });
});

function jobDetail(extra: Partial<JobDetailData> = {}): JobDetailData {
  return {
    job: {
      id: JOB,
      buyer_workspace_id: BUYER_WS,
      seller_id: SELLER,
      listing_version_id: VERSION,
      state: "failed",
      financial_state: "settled",
      created_at: "2026-10-17T00:00:00Z",
      updated_at: "2026-10-17T00:05:00Z",
    },
    quote: {
      id: "11111111-1111-4111-8111-111111111111",
      job_id: JOB,
      fields: { decimals: 6 } as unknown as QuoteFields,
      quote_digest: "b".repeat(64),
      base_units: 1_500_000,
      fee_units: 0,
      total_units: 1_500_000,
      recipient: RECIPIENT,
      recipient_ata: RECIPIENT,
      network: NETWORK,
      mint: MINT,
      expires_at: "2026-10-17T00:05:00Z",
      retired_at: null,
    },
    inputs: [
      { id: "i1", kind: "brief", body: HOSTILE, created_by: "buyer", created_at: "2026-10-17T00:00:00Z" },
      { id: "i2", kind: "question", body: HOSTILE, created_by: "seller", created_at: "2026-10-17T00:01:00Z" },
    ],
    events: [{ seq: 1, kind: "job.created", from_state: null, to_state: "awaiting_approval", actor_type: "buyer", payload: { note: HOSTILE }, created_at: "2026-10-17T00:00:00Z" }],
    artifacts: [{ id: "99999999-9999-4999-8999-999999999999", sha256: "c".repeat(64), mime_type: "text/markdown", bytes: 12, validation_state: "validated", version: 1, created_at: "2026-10-17T00:04:00Z" }],
    receipt: { signature: "5".repeat(88), amount: 1_500_000, mint: MINT, network: NETWORK, finalized_slot: 123, verified_at: "2026-10-17T00:02:00Z" },
    refunds: [{ id: "r1", amount: 500_000, status: "requested", reason: HOSTILE, refund_signature: null, created_at: "2026-10-17T00:06:00Z" }],
    payment: { status: "settled", reject_code: null, updated_at: "2026-10-17T00:02:00Z" },
    label: SERVER_TEST_TOKEN_LABEL,
    ...extra,
  };
}

describe("untrusted content", () => {
  it("has no raw-HTML rendering paths in dashboard source", () => {
    const root = join(__dirname, "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|jsx?)$/.test(name)) files.push(p);
      }
    };
    for (const dir of ["app", "components", "lib"]) walk(join(root, dir));
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|srcDoc|srcdoc|<iframe|createContextualFragment/);
    }
  });

  it("renders listing text from sellers as text, never as markup", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ listing: listing(), samples: [{ id: "s1", title: "Sample", content: HOSTILE }] }));
    const { container } = render(withMarket(marketValue(vi.fn() as unknown as MarketContextValue["call"]), <ListingDetail slug="research-desk" />));
    await screen.findByText("Research desk");
    expect(container.querySelectorAll("script, img, b, iframe, object, embed")).toHaveLength(0);
    expect(screen.getAllByText(HOSTILE).length).toBeGreaterThanOrEqual(4);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("renders briefs, questions and refund reasons as text and keeps a settled failed job visibly paid", async () => {
    const call = vi.fn(async () => jobDetail()) as unknown as MarketContextValue["call"];
    const { container } = render(withMarket(marketValue(call), <JobDetail jobId={JOB} />));
    await screen.findByText("Timeline");
    expect(container.querySelectorAll("script, img, b, iframe, object, embed")).toHaveLength(0);
    expect(screen.getAllByText(HOSTILE).length).toBe(3);
    const states = within(screen.getByRole("list", { name: "Execution and payment states" })).getAllByRole("listitem");
    expect(states[0]!.textContent).toContain("Failed");
    expect(states[1]!.textContent).toContain("Paid — settled on chain");
    expect(screen.getByRole("heading", { name: "Request a refund" })).toBeTruthy();
    expect(screen.getAllByText(/Devnet test tokens — no monetary value/).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /opens Solana devnet explorer/ }).getAttribute("href")).toContain("cluster=devnet");
  });

  it("refuses refund amounts above what is left to refund", async () => {
    const user = userEvent.setup();
    const call = vi.fn(async () => jobDetail()) as unknown as MarketContextValue["call"];
    render(withMarket(marketValue(call), <JobDetail jobId={JOB} />));
    const amount = await screen.findByLabelText("Amount *");
    await user.type(amount, "1.000001");
    expect(screen.getByText("more than the remaining refundable amount")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Request refund" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("pauses identity-sensitive actions while the wallet is on another account", async () => {
    const call = vi.fn(async () => jobDetail({ job: { ...jobDetail().job, state: "awaiting_approval", financial_state: "approval_pending" }, receipt: null, refunds: [] })) as unknown as MarketContextValue["call"];
    render(withMarket(marketValue(call, { mismatch: "Other111111111111111111111111111111111111", canAct: false }), <JobDetail jobId={JOB} />));
    const approve = (await screen.findByRole("button", { name: "Approve quote" })) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(screen.getByText(/Actions are paused/)).toBeTruthy();
  });
});
