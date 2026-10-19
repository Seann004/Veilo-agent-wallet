// @vitest-environment happy-dom
import { clearResourceCache } from "../components/hooks";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConnectors } from "../components/AgentConnectors";
import { MarketContextProvider, type MarketContextValue } from "../components/market/MarketContext";
import { AddCustomDialog } from "../components/ConnectorFlows";
import { ConnectorsPage } from "../components/Connectors";
import { CreateAgent } from "../components/CreateAgent";
import { ApiError } from "../lib/api";
import { endpointProblem, isNotAvailable, parseInputSchema, parseToolsList, reviewChip, setMarketplaceTokenSource, validateProposal } from "../lib/connectors";
import { withRole } from "./access-fixtures";
import { MIRA, PRINCE, SHAWN, agent, workspace } from "./fixtures";

vi.mock("next/navigation", () => ({ usePathname: () => "/connectors", useParams: () => ({}) }));

const MARKET = "https://market.test";

const tool = (name: string, description: string) => ({ name, description, inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }, sha256: "a".repeat(64) });
const SOLANA = {
  id: "solana-developer-docs",
  title: "Solana developer docs",
  endpoint: "https://mcp.solana.com/mcp",
  transport: "streamable_http",
  manifest_sha256: "0123456789abcdef".repeat(4),
  risk: "read_only",
  tools: [tool("search_docs", "Search the Solana developer documentation."), tool("get_page", "Fetch one documentation page."), tool("list_guides", "List guides by topic.")],
};
const METEORA = { ...SOLANA, id: "meteora-docs", title: "Meteora docs", endpoint: "https://docs.meteora.ag/mcp", tools: [tool("search_meteora", "Search Meteora liquidity pool guides.")] };
const COINGECKO = { ...SOLANA, id: "coingecko-docs", title: "CoinGecko API docs", endpoint: "https://docs.coingecko.com/mcp", tools: [tool("lookup_endpoint", "Look up a CoinGecko API endpoint.")] };

interface Call {
  url: string;
  method: string;
  body: unknown;
}

type Reply = { status?: number; body?: unknown };
type Handler = (call: Call) => Reply | undefined;

/** Answers by URL; anything unhandled is a 404 with the control service's JSON shape. */
function serve(handler: Handler) {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const r = handler(call) ?? { status: 404, body: { error: { code: "NOT_FOUND", message: "no such endpoint" } } };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  vi.stubGlobal("fetch", impl);
  return calls;
}

const catalogue =
  (connectors: unknown[], attached: Record<string, unknown[]> = {}): Handler =>
  (c) => {
    if (c.url === `${MARKET}/marketplace/connectors`) return { body: { connectors } };
    const m = /\/api\/control\/agents\/([^/]+)\/connectors$/.exec(c.url);
    if (m && c.method === "GET") return { body: { attached: attached[m[1]!] ?? [] } };
    return undefined;
  };

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_MARKETPLACE_URL", MARKET);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setMarketplaceTokenSource(null);
});

const cards = () => screen.getAllByRole("listitem").filter((li) => li.classList.contains("connector-card"));

describe("Discover", () => {
  it("renders the API's connectors and filters by title, id, tool name and description", async () => {
    serve(catalogue([SOLANA, METEORA, COINGECKO]));
    render(withRole(<ConnectorsPage />));
    await screen.findByRole("button", { name: "Solana developer docs" });
    expect(cards()).toHaveLength(3);
    const first = cards()[0]!;
    expect(within(first).getByText("Read-only")).toBeTruthy();
    expect(within(first).getByText("mcp.solana.com")).toBeTruthy();
    expect(within(first).getByText("3 tools")).toBeTruthy();
    expect(within(first).getByText("Search the Solana developer documentation.")).toBeTruthy();

    const search = screen.getByRole("searchbox", { name: "Search connectors" });
    fireEvent.change(search, { target: { value: "meteora" } });
    expect(cards().map((c) => within(c).getAllByRole("button")[0]!.textContent)).toEqual(["Meteora docs"]);
    fireEvent.change(search, { target: { value: "lookup_endpoint" } });
    expect(cards()).toHaveLength(1);
    fireEvent.change(search, { target: { value: "liquidity pool" } });
    expect(within(cards()[0]!).getByText("Meteora docs")).toBeTruthy();
    fireEvent.change(search, { target: { value: "coingecko-docs" } });
    expect(within(cards()[0]!).getByText("CoinGecko docs search only")).toBeTruthy();
    fireEvent.change(search, { target: { value: "gmail" } });
    expect(screen.queryAllByRole("listitem").filter((li) => li.classList.contains("connector-card"))).toHaveLength(0);
    expect(screen.getByText(/No connectors match/)).toBeTruthy();
  });

  it("says so when nothing is approved, and when the marketplace isn't configured, and never offers sign-in apps", async () => {
    serve(catalogue([]));
    render(withRole(<ConnectorsPage />));
    expect(await screen.findByText(/No connectors are approved yet/)).toBeTruthy();
    cleanup();
    clearResourceCache();
    vi.stubEnv("NEXT_PUBLIC_MARKETPLACE_URL", "");
    const calls = serve(catalogue([SOLANA]));
    render(withRole(<ConnectorsPage />));
    expect(await screen.findByText(/marketplace is not configured/)).toBeTruthy();
    expect(calls.some((c) => c.url.includes("/marketplace/"))).toBe(false);
    // Sign-in apps are listed only as unavailable: no add button and never among usable connectors.
    const soon = screen.getByRole("list", { name: "Apps that are not available yet" });
    for (const name of ["Gmail", "Google Drive", "Notion"]) expect(within(soon).getByText(name)).toBeTruthy();
    expect(within(soon).queryAllByRole("button")).toHaveLength(0);
    expect(within(soon).getAllByText("Soon").length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByRole("list", { name: "Approved connectors" })).toBeNull();
  });

  it("renders hostile titles, descriptions and endpoints as plain text", async () => {
    const hostile = {
      ...SOLANA,
      id: "evil-docs",
      title: '<img src=x onerror="globalThis.pwned=1">Evil',
      endpoint: "https://evil.example/mcp?<b>x</b>",
      tools: [{ ...tool("search", "<script>globalThis.pwned=1</script> [click](javascript:alert(1)) <a href='https://phish.example'>login</a>"), inputSchema: { type: "object", description: "<img src=y>" } }],
    };
    serve(catalogue([hostile]));
    const { container } = render(withRole(<ConnectorsPage />));
    const open = await screen.findByRole("button", { name: '<img src=x onerror="globalThis.pwned=1">Evil' });
    expect(screen.getByText(/<script>globalThis.pwned=1<\/script>/)).toBeTruthy();
    fireEvent.click(open);
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("https://evil.example/mcp?<b>x</b>")).toBeTruthy();
    for (const root of [container, document.body]) {
      // Our own brand logos are the only images; nothing from connector text becomes markup.
      expect([...root.querySelectorAll("img")].every((img) => img.classList.contains("brand-img") && img.getAttribute("src")!.startsWith("/logos/"))).toBe(true);
      expect(root.querySelector("script, b")).toBeNull();
      expect(root.querySelector('a[href^="javascript:"], a[href*="phish"]')).toBeNull();
    }
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
  });

  it("shows the drawer's pinned-tool note, schema and shortened digest, and closes on Escape with focus returned", async () => {
    serve(catalogue([SOLANA]));
    render(withRole(<ConnectorsPage />));
    const open = await screen.findByRole("button", { name: "Solana developer docs" });
    open.focus();
    fireEvent.click(open);
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("Veilo calls only these exact tools; if the server changes them, they are disabled until reviewed again.")).toBeTruthy();
    expect(within(drawer).getByText("search_docs")).toBeTruthy();
    expect(within(drawer).getAllByText("Input schema")).toHaveLength(3);
    expect(within(drawer).getByText("0123456789…abcdef")).toBeTruthy();
    expect(within(drawer).getByText("https://mcp.solana.com/mcp").tagName).not.toBe("A");
    expect(drawer.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Solana developer docs" }));
  });

  it("labels a templated tool as a fixed Veilo query on the server's code tool", async () => {
    const market = {
      ...SOLANA,
      id: "coingecko-market",
      title: "CoinGecko market data",
      endpoint: "https://mcp.api.coingecko.com/mcp",
      tools: [{ ...tool("coingecko_simple_price", "Live price from CoinGecko's public API."), template: { upstream: "execute", upstreamSha256: "b".repeat(64), codeSha256: "c".repeat(64) } }, tool("search_docs", "Search the CoinGecko docs.")],
    };
    serve(catalogue([market]));
    render(withRole(<ConnectorsPage />));
    fireEvent.click(await screen.findByRole("button", { name: "CoinGecko market data" }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("coingecko_simple_price")).toBeTruthy();
    expect(within(drawer).getAllByText(/Fixed Veilo query run through the server/)).toHaveLength(1);
    expect(within(drawer).getByText("execute").className).toContain("mono");
  });

  it("uses a tablist that moves with the arrow keys", async () => {
    serve(catalogue([SOLANA]));
    render(withRole(<ConnectorsPage />));
    const discover = screen.getByRole("tab", { name: "Discover" });
    expect(discover.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(discover, { key: "ArrowLeft" });
    const yours = screen.getByRole("tab", { name: "Yours" });
    expect(yours.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(yours);
    expect(screen.getByRole("tabpanel", { name: "Yours" })).toBeTruthy();
    fireEvent.keyDown(yours, { key: "Home" });
    expect(screen.getByRole("tab", { name: "Discover" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("Add custom MCP server", () => {
  const openDialog = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Custom MCP server/ }));
    return screen.findByRole("dialog", { name: "Custom MCP server" });
  };

  it("rejects non-https endpoints and bad JSON schemas before sending anything", async () => {
    const calls = serve(catalogue([SOLANA]));
    render(withRole(<ConnectorsPage />));
    const dialog = await openDialog();
    expect(within(dialog).getByText("Read-only tools only.")).toBeTruthy();
    expect(within(dialog).getByText(/operator checks the live server before approving it/)).toBeTruthy();
    expect(within(dialog).getByText("In review")).toBeTruthy();
    expect(within(dialog).queryByLabelText(/key|token|password/i)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("ID"), { target: { value: "my-docs" } });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "My docs" } });
    fireEvent.change(within(dialog).getByLabelText("Endpoint (https)"), { target: { value: "http://mcp.example.com/mcp" } });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "search" } });
    fireEvent.change(within(dialog).getByLabelText("Input schema (JSON)"), { target: { value: '{"type": "object",' } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Submit for review" }));
    expect(await within(dialog).findByText("The endpoint must use https.")).toBeTruthy();
    expect(within(dialog).getByText("Not valid JSON.")).toBeTruthy();
    expect(within(dialog).getByLabelText("Endpoint (https)").getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(within(dialog).getByLabelText("Endpoint (https)"), { target: { value: "https://localhost/mcp" } });
    fireEvent.change(within(dialog).getByLabelText("Input schema (JSON)"), { target: { value: "[1, 2]" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Submit for review" }));
    expect(await within(dialog).findByText(/must be a public domain name/)).toBeTruthy();
    expect(within(dialog).getByText("The schema must be a JSON object.")).toBeTruthy();
    expect(calls.some((c) => c.url.includes("/tools/connectors"))).toBe(false);
  });

  it("fills tools from pasted tools/list JSON and says sending isn't available without a marketplace sign-in", async () => {
    const calls = serve(catalogue([SOLANA]));
    render(withRole(<ConnectorsPage />));
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Paste tools/list JSON" }));
    fireEvent.change(within(dialog).getByLabelText("tools/list result"), {
      target: { value: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "a", description: "A", inputSchema: { type: "object" } }, { name: "b", inputSchema: { type: "object" } }] } }) },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Use these tools" }));
    expect(within(dialog).getAllByLabelText("Name").map((n) => (n as HTMLInputElement).value)).toEqual(["a", "b"]);
    fireEvent.change(within(dialog).getByLabelText("ID"), { target: { value: "my-docs" } });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "My docs" } });
    fireEvent.change(within(dialog).getByLabelText("Endpoint (https)"), { target: { value: "https://mcp.example.com/mcp" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Submit for review" }));
    expect(await within(dialog).findByText(/marketplace sign-in is not part of this dashboard yet/)).toBeTruthy();
    expect(within(dialog).queryByText(/Submitted/)).toBeNull();
    expect(calls.some((c) => c.url.includes("/tools/connectors"))).toBe(false);
  });

  it("closes on Escape and returns focus to the Add button", async () => {
    serve(catalogue([SOLANA]));
    render(withRole(<ConnectorsPage />));
    const dialog = await openDialog();
    expect(document.activeElement).toBe(within(dialog).getByLabelText("ID"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add" }));
  });

  it("validates like the marketplace does", () => {
    expect(endpointProblem("ftp://x.example/mcp")).toMatch(/https/);
    expect(endpointProblem("https://10.0.0.1/mcp")).toMatch(/public domain/);
    expect(endpointProblem("https://user:pw@x.example/mcp")).toMatch(/credentials/);
    expect(endpointProblem("https://mcp.example.com/mcp")).toBeNull();
    expect(parseInputSchema('{"type":"string"}')).toEqual({ problem: 'The schema must have "type": "object".' });
    expect(parseToolsList("{}")).toEqual({ problem: 'Expected {"tools": [...]} from tools/list.' });
    const dup = validateProposal({ id: "ok-id", title: "Fine", endpoint: "https://a.example/mcp", tools: [{ name: "x", description: "", schema: '{"type":"object"}' }, { name: "x", description: "", schema: '{"type":"object"}' }] });
    expect(dup.proposal).toBeNull();
    expect(dup.problems.tool[1]!.name).toMatch(/unique/);
    expect(validateProposal({ id: "Bad ID", title: "x", endpoint: "https://a.example/mcp", tools: [] }).problems).toMatchObject({ id: expect.any(String), title: expect.any(String), tools: "Add at least one tool." });
  });
});

describe("attach flow", () => {
  it("sends exactly the ticked tools and shows Connected only once the API lists it", async () => {
    let attached: unknown[] = [];
    const calls = serve((c) => {
      if (c.method === "PUT" && c.url.endsWith(`/agents/${SHAWN}/connectors/solana-developer-docs`)) {
        attached = [{ connectorId: "solana-developer-docs", tools: (c.body as { tools: string[] }).tools, attachedAt: "2026-10-17T00:00:00.000Z" }];
        return { body: { ok: true } };
      }
      return catalogue([SOLANA], { [SHAWN]: attached })(c);
    });
    render(withRole(<ConnectorsPage />));
    await screen.findByRole("button", { name: "Solana developer docs" });
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/connectors") && c.url.includes("/api/control/agents/")).length).toBe(3));
    fireEvent.click(within(cards()[0]!).getByRole("button", { name: "Add to agent" }));
    const dialog = await screen.findByRole("dialog");
    const boxes = within(dialog).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, true, true]);
    fireEvent.click(boxes[1]!);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to Shawn" }));
    expect(await within(dialog).findByText(/Connected to Shawn/)).toBeTruthy();
    const put = calls.filter((c) => c.method === "PUT");
    expect(put).toHaveLength(1);
    expect(put[0]!.url).toBe(`/api/control/agents/${SHAWN}/connectors/solana-developer-docs`);
    expect(put[0]!.body).toEqual({ tools: ["search_docs", "list_guides"] });    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Done" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows no check state when the PUT succeeds but the API doesn't list the attachment", async () => {
    serve((c) => (c.method === "PUT" ? { body: { ok: true } } : catalogue([SOLANA])(c)));
    const { container } = render(withRole(<ConnectorsPage />));
    await screen.findByRole("button", { name: "Solana developer docs" });
    expect(screen.queryByText(/Used by/)).toBeNull();
    fireEvent.click(within(cards()[0]!).getByRole("button", { name: "Add to agent" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to Shawn" }));
    expect(await within(dialog).findByText(/isn.t shown as connected/)).toBeTruthy();
    expect(within(dialog).queryByText(/Connected to/)).toBeNull();
    expect(container.querySelector(".connector-used")).toBeNull();
  });

  it("marks agents that already use a connector from the API and removes with DELETE", async () => {
    const calls = serve((c) =>
      c.method === "DELETE" ? { status: 204 } : catalogue([SOLANA], { [PRINCE]: [{ connectorId: "solana-developer-docs", tools: ["search_docs"], attachedAt: "2026-10-17T00:00:00.000Z" }] })(c),
    );
    render(withRole(<ConnectorsPage />));
    expect(await screen.findByText("Used by 1 agent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Solana developer docs" }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("Prince")).toBeTruthy();
    expect(within(drawer).getByText(/1 of 3 tools/)).toBeTruthy();
    fireEvent.click(within(drawer).getByRole("button", { name: "Remove Solana developer docs from Prince" }));
    fireEvent.click(within(drawer).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === `/api/control/agents/${PRINCE}/connectors/solana-developer-docs`)).toBe(true));
  });

  it("keeps viewers and guests read-only with a reason and asks control for nothing", async () => {
    for (const role of ["viewer", "guest"] as const) {
      const calls = serve(catalogue([SOLANA]));
      render(withRole(<ConnectorsPage />, role));
      await screen.findByRole("button", { name: "Solana developer docs" });
      expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
      expect((within(cards()[0]!).getByRole("button", { name: "Add to agent" }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText(role === "viewer" ? /Read-only view/ : /Only the workspace owner/)).toBeTruthy();
      expect(calls.some((c) => c.url.includes("/api/control/"))).toBe(false);
      cleanup();
    }
  });
});

describe("not available yet", () => {
  it("shows Not available yet when /agents/:id/connectors returns 404, on the agent page and in Yours", async () => {
    serve((c) => (c.url.startsWith(MARKET) ? catalogue([SOLANA])(c) : undefined));
    const prince = agent(PRINCE, "Prince", "research");
    render(withRole(<AgentConnectors agent={prince} />));
    expect(await screen.findByText("Not available yet.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Add connector" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/Connected/)).toBeNull();
    cleanup();

    render(withRole(<ConnectorsPage />));
    fireEvent.click(screen.getByRole("tab", { name: "Yours" }));
    expect(await screen.findByText("Not available yet.")).toBeTruthy();
    // Without marketplace sign-in there are no proposals to list, so the section is not shown.
    expect(screen.queryByText("Your proposals")).toBeNull();
  });

  it("lists attached connectors with tool chips and opens the picker with only unattached ones", async () => {
    serve(catalogue([SOLANA, METEORA], { [PRINCE]: [{ connectorId: "meteora-docs", tools: ["search_meteora"], attachedAt: "2026-10-17T00:00:00.000Z" }] }));
    render(withRole(<AgentConnectors agent={agent(PRINCE, "Prince", "research")} />));
    expect(await screen.findByText("Meteora docs")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Allowed tools" })).getByText("search_meteora")).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("button", { name: "Add connector" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Add connector" }));
    const picker = await screen.findByRole("dialog", { name: "Add connector" });
    expect(within(picker).getByText("Solana developer docs")).toBeTruthy();
    expect(within(picker).queryByText("Meteora docs")).toBeNull();
  });
});

describe("honest states", () => {
  it("shows a changed attachment as disabled, never with a check", async () => {
    serve(catalogue([SOLANA], { [PRINCE]: [{ connectorId: "solana-developer-docs", tools: ["search_docs"], attachedAt: "2026-10-17T00:00:00.000Z", status: "changed" }] }));
    render(withRole(<AgentConnectors agent={agent(PRINCE, "Prince", "research")} />));
    expect(await screen.findByText("Disabled: the server changed its tools")).toBeTruthy();
    expect(document.querySelector(".agent-connectors .icon")).toBeNull();
    cleanup();
    render(withRole(<ConnectorsPage />));
    await screen.findByRole("button", { name: "Solana developer docs" });
    await waitFor(() => expect(document.querySelector(".connector-card")).toBeTruthy());
    expect(screen.queryByText(/Used by/)).toBeNull();
    expect(document.querySelector(".connector-used")).toBeNull();
  });

  it("treats only a missing route as not available yet, and labels unknown review states as-is", () => {
    expect(isNotAvailable(new ApiError(404, "NOT_FOUND", "no such endpoint"))).toBe(true);
    expect(isNotAvailable(new ApiError(404, "NOT_READY", "the control service does not serve this endpoint yet"))).toBe(true);
    expect(isNotAvailable(new ApiError(404, "NOT_FOUND", "connector is not attached to this agent"))).toBe(false);
    expect(isNotAvailable(new ApiError(503, "NOT_READY", "agent connectors are not configured"))).toBe(false);
    expect(reviewChip("pending").label).toBe("In review");
    expect(reviewChip("withdrawn").label).toBe("Withdrawn");
    expect(reviewChip("rejected")).toEqual({ label: "Rejected", className: "pill pill-muted" });
  });
});

describe("create agent with connectors", () => {
  it("reports an agent created with some attachments failed, and retries only those", async () => {
    let fail = true;
    const attached: unknown[] = [];
    const created = agent("99999999-9999-4999-8999-999999999999", "Nova", "research", "draft");
    const calls = serve((c) => {
      if (c.url === "/api/control/agents" && c.method === "POST") return { body: { agent: created } };
      if (c.method === "PUT") {
        const id = c.url.split("/").at(-1)!;
        if (id === "meteora-docs" && fail) return { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "upstream exploded" } } };
        attached.push({ connectorId: id, tools: (c.body as { tools: string[] }).tools, attachedAt: "2026-10-17T00:00:00.000Z" });
        return { body: { ok: true } };
      }
      if (c.url.endsWith(`/agents/${created.id}/connectors`)) return { body: { attached } };
      return catalogue([SOLANA, METEORA])(c);
    });
    render(withRole(<CreateAgent />, "owner", workspace({ agents: [agent(SHAWN, "Shawn", "credit_manager"), agent(MIRA, "Mira", "content")] })));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Nova" } });
    const group = await screen.findByRole("group", { name: "Connectors to add" });
    fireEvent.click(within(group).getByRole("button", { name: "Solana developer docs" }));
    fireEvent.click(within(group).getByRole("button", { name: "Meteora docs" }));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create agent" }));
    expect(await screen.findByText(/Nova was created, but 1 of 2 connectors couldn.t be added/)).toBeTruthy();
    expect(screen.getByText(/upstream exploded/)).toBeTruthy();
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ tools: ["search_docs", "get_page", "list_guides"] }, { tools: ["search_meteora"] }]);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry it" }));
    await waitFor(() => expect(screen.queryByText(/couldn.t be added/)).toBeNull());
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.url.split("/").at(-1))).toEqual(["solana-developer-docs", "meteora-docs", "meteora-docs"]);
    expect(screen.getAllByText(/Connected/)).toHaveLength(2);
  });
});


describe("CoinGecko fixed-query proposal", () => {
  it("loads and submits the fixed pins, never a code editor or an approval", async () => {
    setMarketplaceTokenSource(async () => "marketplace-test-session");
    const endpoint = "https://mcp.api.coingecko.com/mcp";
    const tools = [{ name: "coingecko_simple_price", description: "Get a price", inputSchema: { type: "object" }, template: { upstream: "execute", codeSha256: "a".repeat(64), upstreamSha256: "b".repeat(64) } }, { name: "search_docs", description: "Search docs", inputSchema: { type: "object" } }];
    const calls = serve(c => {
      if (c.url.endsWith("/template-preview")) return { body: { connectorId: "coingecko-market", title: "CoinGecko market data", endpoint, explanation: "Fixed queries", tools } };
      if (c.url.endsWith("/tools/connectors")) return { body: { connectorId: "coingecko-market", status: "pending" } };
      return undefined;
    });
    render(<AddCustomDialog onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Endpoint (https)"), { target: { value: endpoint } });
    expect(screen.getByText(/Veilo runs fixed CoinGecko queries/)).toBeTruthy();
    expect(screen.queryByLabelText("Input schema (JSON)")).toBeNull();
    expect((screen.getByRole("button", { name: "Submit for review" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Load fixed queries" }));
    await screen.findByText("coingecko_simple_price");
    fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
    await screen.findByText(/Submitted/);
    expect(calls.map(c => c.url)).toEqual([`${MARKET}/tools/connectors/template-preview`, `${MARKET}/tools/connectors`]);
    expect(calls[1]!.body).toEqual({ id: "coingecko-market", title: "CoinGecko market data", endpoint, tools });
    expect(screen.getByText("In review")).toBeTruthy();
  });
});


describe("custom connector marketplace identity", () => {
  it("submits through the existing marketplace session without a global token bridge", async () => {
    const accessToken = vi.fn(async () => "existing-marketplace-session");
    const market = { configured: true, ready: true, canAct: true, me: { address: "Owner1111111111111111111111111111111111111" }, wallet: null, mismatch: null, accessToken } as unknown as MarketContextValue;
    const calls = serve(c => c.url.endsWith("/tools/connectors") ? { body: { connectorId: "my-docs", status: "pending" } } : undefined);
    render(<MarketContextProvider value={market}><AddCustomDialog onClose={() => {}} /></MarketContextProvider>);
    expect(screen.getByText(/Signed in to the marketplace as/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("ID"), { target: { value: "my-docs" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "My docs" } });
    fireEvent.change(screen.getByLabelText("Endpoint (https)"), { target: { value: "https://mcp.example.com/mcp" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "search" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
    await screen.findByText(/Submitted/);
    expect(accessToken).toHaveBeenCalledOnce();
    expect(calls.map(c => c.url)).toEqual([`${MARKET}/tools/connectors`]);
  });

  it("pauses proposal actions when the marketplace wallet switched", () => {
    const market = { configured: true, ready: true, canAct: false, me: { address: "Original" }, wallet: null, mismatch: "Different", accessToken: vi.fn() } as unknown as MarketContextValue;
    render(<MarketContextProvider value={market}><AddCustomDialog onClose={() => {}} /></MarketContextProvider>);
    fireEvent.change(screen.getByLabelText("Endpoint (https)"), { target: { value: "https://mcp.api.coingecko.com/mcp" } });
    expect((screen.getByRole("button", { name: "Submit for review" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Load fixed queries" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
