// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ROLES, AGENT_TEMPLATES as CONTRACT_TEMPLATES, createAgentRequestSchema, runAgentRequestSchema, customTaskInputSchema, agentPolicyInputSchema } from "@veilo/contracts";
import { SPECIALIST_SKU } from "@veilo/contracts/marketplace";
import { CreateAgent } from "../components/CreateAgent";
import { CUSTOM_INSTRUCTIONS_MAX, CustomAgentPanel, CustomRunForm, TEMPLATE_LABEL, withHiring } from "../components/CustomAgentFields";
import { MarketContextProvider, type MarketContextValue } from "../components/market/MarketContext";
import { AgentRow } from "../components/Overview";
import { ROLE_TEMPLATES } from "../components/Policy";
import { OwnerProvider } from "../components/Shell";
import { ROLE_LABEL } from "../lib/labels";
import { summarizeResult } from "../lib/results";
import { AGENT_TEMPLATES, type Agent, type Job } from "../lib/types";
import { accessFor, withRole } from "./access-fixtures";
import { agent, workspace } from "./fixtures";

vi.mock("next/navigation", () => ({ usePathname: () => "/agents/new", useParams: () => ({}) }));

const CUSTOM_ID = "66666666-6666-4666-8666-666666666666";
const LISTING = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RECIPIENT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

interface Call {
  url: string;
  method: string;
  body: unknown;
}
let calls: Call[];
let respond: (c: Call) => { status?: number; body: unknown };

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.stubEnv("NEXT_PUBLIC_MARKETPLACE_URL", "http://127.0.0.1:4106");
  document.cookie = "veilo_csrf=csrf-custom";
  calls = [];
  respond = () => ({ body: {} });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const c = { url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(c);
    const r = respond(c);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function customAgent(overrides: Partial<Agent> = {}): Agent {
  return { ...agent(CUSTOM_ID, "Scout", "custom"), template: "researcher", instructions: "Find one specialist.", ...overrides };
}

function market(): MarketContextValue {
  return {
    configured: true,
    ready: true,
    me: null,
    meError: undefined,
    reloadMe: async () => undefined,
    wallet: null,
    mismatch: null,
    canAct: false,
    token: { network: NETWORK, mint: MINT, decimals: 6 },
    decimalsFor: () => 6,
    tokenError: undefined,
    signIn: async () => undefined,
    signOut: async () => undefined,
    disconnectWallet: async () => undefined,
    connectWallet: async () => undefined,
    call: async () => {
      throw new Error("not used");
    },
    accessToken: async () => null,
  };
}

function renderCreate(node: ReactNode = <CreateAgent />) {
  return render(
    <OwnerProvider value={{ workspace: workspace(), reloadWorkspace: async () => undefined, connected: null, setConnected: () => undefined, access: accessFor("owner") }}>
      <MarketContextProvider value={market()}>{node}</MarketContextProvider>
    </OwnerProvider>,
  );
}

const listing = { listing_id: LISTING, listing_version_id: "v", slug: "desk", seller_name: "Desk", title: "Research desk", summary: "", recipient: RECIPIENT, price_base_units: "250000", mint: MINT, network: NETWORK };

/** Control answers: agent create returns the new custom agent; allowlist PUT follows `allowlist`. */
function backend(allowlist: () => { status?: number; body: unknown } = () => ({ body: { grants: [] } })) {
  respond = (c) => {
    if (c.url.startsWith("http://127.0.0.1:4106/marketplace/listings")) return { body: { listings: [listing] } };
    if (c.url === "/api/control/agents" && c.method === "POST") {
      const b = c.body as { role: Agent["role"]; name: string };
      return { status: 201, body: { agent: { ...agent(CUSTOM_ID, b.name, b.role, "draft"), activePolicy: null } } };
    }
    if (c.url.endsWith("/marketplace-allowlist")) return allowlist();
    return { body: {} };
  };
}

/** Role picker buttons are named by the role label followed by its tagline. */
const roleButton = (role: keyof typeof ROLE_LABEL) => screen.getByRole("button", { name: new RegExp(`^${ROLE_LABEL[role]}`) });

async function pick(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByLabelText(label));
  await user.click(await screen.findByRole("option", { name: option }));
}

async function fillCustom(user: ReturnType<typeof userEvent.setup>) {
  await user.click(roleButton("custom"));
  await user.type(screen.getByLabelText("Name"), "Scout");
  await user.type(screen.getByLabelText("Instructions *"), "Find one specialist.");
  await pick(user, "Starting template", "Analyst");
}

async function submitTwice(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Review" }));
  await user.click(screen.getByRole("button", { name: "Create agent" }));
}

const createBody = () => calls.find((c) => c.url === "/api/control/agents" && c.method === "POST")?.body as Record<string, unknown> & { policy: { allowedSkus: string[]; allowedPaymentPaths: string[] } };

describe("custom agent roles and maps", () => {
  it("covers every contract role in each role map and mirrors the template list", () => {
    expect(Object.keys(ROLE_LABEL).sort()).toEqual([...AGENT_ROLES].sort());
    expect(Object.keys(ROLE_TEMPLATES).sort()).toEqual([...AGENT_ROLES].sort());
    expect([...AGENT_TEMPLATES]).toEqual([...CONTRACT_TEMPLATES]);
    expect(Object.keys(TEMPLATE_LABEL).sort()).toEqual([...CONTRACT_TEMPLATES].sort());
    expect(ROLE_LABEL.custom).toBe("Custom agent");
    for (const role of AGENT_ROLES) expect(agentPolicyInputSchema.safeParse(ROLE_TEMPLATES[role].policy).success).toBe(true);
  });

  it("keeps the custom template unable to pay until hiring is switched on; its own work uses the owner's model", () => {
    const base = ROLE_TEMPLATES.custom.policy;
    expect(base.allowedSkus).toEqual([]);
    expect(base.allowedPaymentPaths).toEqual(["private_x402"]);
    const on = withHiring(base, true);
    expect(on.allowedSkus).toEqual([SPECIALIST_SKU]);
    expect(on.allowedPaymentPaths).toContain("private_x402");
    expect(withHiring(on, false).allowedSkus).toEqual([]);
    expect(withHiring({ ...base, allowedPaymentPaths: [] }, true).allowedPaymentPaths).toEqual(["private_x402"]);
  });

  it("renders a custom agent row with its own label and a link to its page", () => {
    render(
      <ul>
        <AgentRow agent={customAgent()} budget={undefined} task={undefined} job={undefined} stopped={false} />
      </ul>,
    );
    expect(screen.getByText(/Custom agent/)).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe(`/agents/${CUSTOM_ID}`);
  });

  it("summarizes a custom job's hire proposal without calling it paid", () => {
    const job = { id: "j", kind: "custom", state: "completed", taskId: "t", result: { hire: { proposalId: "p1", state: "pending" }, artifactId: "a1" } } as unknown as Job;
    expect(summarizeResult(job)).toBe("custom completed · hire proposed (unpaid until you approve it or it matches a pre-approved listing) · result saved to Content");
    const refused = { ...job, result: { hire: { code: "POLICY_DENIED" } } } as unknown as Job;
    expect(summarizeResult(refused)).toBe("custom completed · hire refused (POLICY_DENIED)");
  });
});

describe("create a custom agent", () => {
  it("offers Custom in the role picker and shows its fields only for that role", async () => {
    const user = userEvent.setup();
    renderCreate();
    expect(roleButton("custom").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByLabelText("Instructions *")).toBeNull();
    await user.click(roleButton("custom"));
    expect(roleButton("custom").getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("Instructions *") as HTMLTextAreaElement).maxLength).toBe(CUSTOM_INSTRUCTIONS_MAX);
    await user.click(screen.getByLabelText("Starting template"));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(CONTRACT_TEMPLATES.map((t) => TEMPLATE_LABEL[t]));
    await user.keyboard("{Escape}");
    const hiring = screen.getByLabelText("Allow this agent to hire specialists from the marketplace") as HTMLInputElement;
    expect(hiring.checked).toBe(false);
    expect(screen.queryByText("Pre-approved listings (optional)")).toBeNull();
  });

  it("requires instructions before review", async () => {
    const user = userEvent.setup();
    renderCreate();
    await user.click(roleButton("custom"));
    await user.type(screen.getByLabelText("Name"), "Scout");
    expect((screen.getByRole("button", { name: "Review" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("Instructions *"), "   ");
    expect((screen.getByRole("button", { name: "Review" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("posts role custom with template and instructions, no hiring permission and no allowlist call by default", async () => {
    const user = userEvent.setup();
    backend();
    renderCreate();
    await fillCustom(user);
    await submitTwice(user);
    await screen.findByText("Scout is ready");
    const body = createBody();
    expect(body).toMatchObject({ name: "Scout", role: "custom", template: "analyst", instructions: "Find one specialist.", trigger: { type: "owner_task" } });
    expect(body.policy.allowedSkus).not.toContain(SPECIALIST_SKU);
    expect(createAgentRequestSchema.safeParse(body).success).toBe(true);
    expect(calls.some((c) => c.url.includes("marketplace-allowlist"))).toBe(false);
    expect(screen.getByText(/the dashboard never issues one/)).toBeTruthy();
  });

  it("omits template and instructions for the other roles", async () => {
    const user = userEvent.setup();
    backend();
    renderCreate();
    await user.click(roleButton("custom"));
    await user.type(screen.getByLabelText("Instructions *"), "Left behind");
    await user.click(roleButton("research"));
    await user.type(screen.getByLabelText("Name"), "Prince");
    await submitTwice(user);
    await screen.findByText("Prince is ready");
    const body = createBody();
    expect(body.role).toBe("research");
    expect("template" in body).toBe(false);
    expect("instructions" in body).toBe(false);
    expect(createAgentRequestSchema.safeParse(body).success).toBe(true);
  });

  it("allows hiring and saves pre-approved listings after the agent is created", async () => {
    const user = userEvent.setup();
    backend();
    renderCreate();
    await fillCustom(user);
    await user.click(screen.getByLabelText("Allow this agent to hire specialists from the marketplace"));
    await pick(user, "Listing", "Research desk — Desk");
    await user.type(screen.getByLabelText("Maximum total per hire"), "0.3");
    await user.click(screen.getByRole("button", { name: "Pre-approve listing" }));
    await submitTwice(user);
    await screen.findByText("1 pre-approved listing(s) saved.");
    expect(createBody().policy.allowedSkus).toContain(SPECIALIST_SKU);
    const create = calls.findIndex((c) => c.url === "/api/control/agents");
    const put = calls.findIndex((c) => c.url === `/api/control/agents/${CUSTOM_ID}/marketplace-allowlist`);
    expect(put).toBeGreaterThan(create);
    expect(calls[put]!.method).toBe("PUT");
    expect(calls[put]!.body).toEqual({ grants: [{ listingId: LISTING, recipient: RECIPIENT, maxTotalUnits: "300000" }] });
  });

  it("enabling hiring without pre-approved listings makes no allowlist call", async () => {
    const user = userEvent.setup();
    backend();
    renderCreate();
    await fillCustom(user);
    await user.click(screen.getByLabelText("Allow this agent to hire specialists from the marketplace"));
    await submitTwice(user);
    await screen.findByText("Scout is ready");
    expect(createBody().policy.allowedSkus).toContain(SPECIALIST_SKU);
    expect(calls.some((c) => c.url.includes("marketplace-allowlist"))).toBe(false);
  });

  it("reports a created agent whose listings were not saved and retries only the allowlist", async () => {
    const user = userEvent.setup();
    let fail = true;
    backend(() => (fail ? { status: 503, body: { error: { code: "NOT_READY", message: "the marketplace is not configured (MARKETPLACE_URL)" } } } : { body: { grants: [] } }));
    renderCreate();
    await fillCustom(user);
    await user.click(screen.getByLabelText("Allow this agent to hire specialists from the marketplace"));
    await pick(user, "Listing", "Research desk — Desk");
    await user.type(screen.getByLabelText("Maximum total per hire"), "0.3");
    await user.click(screen.getByRole("button", { name: "Pre-approve listing" }));
    await submitTwice(user);
    const alert = await screen.findByText(/The agent was created, but its pre-approved listings were not saved/);
    expect(alert).toBeTruthy();
    expect(screen.getByText("Scout is ready")).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry saving pre-approved listings" }));
    await screen.findByText("1 pre-approved listing(s) saved.");
    expect(calls.filter((c) => c.url === "/api/control/agents" && c.method === "POST")).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith("/marketplace-allowlist") && c.method === "PUT")).toHaveLength(2);
  });
});

describe("custom agent jobs", () => {
  it("posts the objective with optional context and search terms in the run body", async () => {
    const user = userEvent.setup();
    respond = () => ({ status: 202, body: { taskId: "t1", executor: "queued in the durable scheduler" } });
    const onQueued = vi.fn();
    render(<CustomRunForm agent={customAgent()} disabled={false} onQueued={onQueued} />);
    await user.type(screen.getByLabelText("Job for Scout *"), "Compare three vector databases");
    await user.type(screen.getByLabelText("Context (optional)"), "Small team");
    await user.type(screen.getByLabelText("Marketplace search terms (optional)"), "database review");
    await user.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect(onQueued).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({ url: `/api/control/agents/${CUSTOM_ID}/run`, method: "POST" });
    const body = calls[0]!.body as { objective: string; input: unknown };
    expect(body).toEqual({ objective: "Compare three vector databases", input: { context: "Small team", searchQuery: "database review" } });
    expect(runAgentRequestSchema.safeParse(body).success).toBe(true);
    expect(customTaskInputSchema.safeParse(body.input).success).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Task t1");
  });

  it("sends only the objective when nothing optional is filled and blocks a stopped agent", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CustomRunForm agent={customAgent()} disabled={false} onQueued={vi.fn()} />);
    await user.type(screen.getByLabelText("Job for Scout *"), "Find a translator");
    await user.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ objective: "Find a translator" });
    rerender(<CustomRunForm agent={customAgent()} disabled onQueued={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Start job" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("custom agent page", () => {
  const policy = { ...ROLE_TEMPLATES.custom.policy };

  it("shows template and instructions and saves only the changed fields", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn(async () => undefined);
    renderCreate(<CustomAgentPanel agent={customAgent()} policy={policy} canRun terminal={false} onChanged={onChanged} />);
    expect(screen.getByText("Researcher", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText("Find one specialist.", { selector: "dd *" })).toBeTruthy();
    const box = screen.getByRole("textbox", { name: "Instructions" });
    await user.clear(box);
    await user.type(box, "Prefer reviewed sellers.");
    await user.click(screen.getByRole("button", { name: "Save instructions" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({ url: `/api/control/agents/${CUSTOM_ID}/config`, method: "PATCH", body: { instructions: "Prefer reviewed sellers." } });
  });

  it("drafts a policy that adds the hiring permission instead of changing the active one", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn(async () => undefined);
    renderCreate(<CustomAgentPanel agent={customAgent()} policy={policy} canRun terminal={false} onChanged={onChanged} />);
    expect(screen.getByText("off")).toBeTruthy();
    expect(screen.queryByText(/Pre-approved listings for Scout/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Draft a policy that allows hiring" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const body = calls[0]!.body as { policy: { allowedSkus: string[] } };
    expect(calls[0]!.method).toBe("PATCH");
    expect(Object.keys(body)).toEqual(["policy"]);
    expect(body.policy.allowedSkus).toEqual([SPECIALIST_SKU]);
    expect(screen.getByRole("link", { name: "seller console" }).getAttribute("href")).toBe("/marketplace/seller");
  });

  it("hands the agent's instructions to a new seller listing", async () => {
    const user = userEvent.setup();
    renderCreate(<CustomAgentPanel agent={customAgent()} policy={policy} canRun terminal={false} onChanged={vi.fn()} />);
    const link = screen.getByRole("link", { name: "Create a listing" });
    expect(link.getAttribute("href")).toBe("/marketplace/seller");
    await user.click(link);
    expect(JSON.parse(sessionStorage.getItem("veilo.offerDraft") ?? "{}")).toEqual({ title: customAgent().name, sellerInstructions: customAgent().instructions });
    expect(screen.getByText(/don.t use this agent.s connectors, AI credits or your private pool/)).toBeTruthy();
  });

  it("lets a guest run jobs but not edit instructions or hiring", async () => {
    const user = userEvent.setup();
    const hiringAgent = customAgent({ activePolicy: { ...customAgent().activePolicy!, permissions: { ...customAgent().activePolicy!.permissions, allowedSkus: [SPECIALIST_SKU] } } });
    render(withRole(<MarketContextProvider value={market()}><CustomAgentPanel agent={hiringAgent} policy={withHiring(policy, true)} canRun terminal={false} onChanged={vi.fn()} /></MarketContextProvider>, "guest"));
    await user.type(screen.getByLabelText(/^Job for Scout/), "Find a reviewer.");
    expect((screen.getByRole("button", { name: "Start job" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Save instructions" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Draft a policy/ })).toBeNull();
    expect(screen.queryByText(/Pre-approved listings for Scout/)).toBeNull();
    expect(screen.getByText("Only the workspace owner can do this.")).toBeTruthy();
  });

  it("keeps every custom agent control disabled for the public viewer", async () => {
    const user = userEvent.setup();
    render(withRole(<MarketContextProvider value={market()}><CustomAgentPanel agent={customAgent()} policy={policy} canRun terminal={false} onChanged={vi.fn()} /></MarketContextProvider>, "viewer"));
    await user.type(screen.getByLabelText(/^Job for Scout/), "Find a reviewer.");
    expect((screen.getByRole("button", { name: "Start job" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Sign in to run agents.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save instructions" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Draft a policy/ })).toBeNull();
  });
});
