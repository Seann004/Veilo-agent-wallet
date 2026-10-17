"use client";

import { useId, useState } from "react";
import type { ToolManifest } from "@veilo/contracts/marketplace";
import { marketApi } from "../../lib/market/client";
import type { SellerDashboard } from "../../lib/market/types";
import { BADGE_CLASS, BADGE_LABEL, kindGlyph, type ToolEntry } from "../../lib/market/workflows";
import { useAction, useResource } from "../hooks";
import { EmptyState, ErrorNotice, Loading, Section } from "../ui";
import { useMarket } from "./MarketContext";
import { Address, Money, PlainText, RequireMarketSession, TestTokenNote } from "./parts";
import { Select } from "../Select";

interface Connector {
  id: string;
  title: string;
  endpoint: string;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; sha256: string }>;
}

interface ToolsResponse {
  tools: ToolEntry[];
  providers: Array<{ provider: string; manifestSha256: string; tools: ToolManifest["tools"] }>;
}

/** Published tools any workflow may chain, with whether each can be bought right now. */
export function ToolLibrary() {
  const m = useMarket();
  const res = useResource(() => (m.configured ? marketApi<ToolsResponse>("/marketplace/tools") : Promise.resolve({ tools: [], providers: [] })), "tool-library");
  return (
    <>
      <h1>Tool library</h1>
      <p className="small">
        Tools are published listings and operator-approved external x402 resources. A workflow built only from approved tools goes live after automated checks; a new tool waits for
        review.
      </p>
      <TestTokenNote />
      {res.loading && !res.data ? <Loading label="tools" /> : null}
      <ErrorNotice error={res.error} what="the tool library could not be loaded" onRetry={res.reload} />
      {res.data && res.data.tools.length === 0 ? <EmptyState>No tools are published yet.</EmptyState> : null}
      {res.data && res.data.tools.length > 0 ? (
        <ul className="cards tool-cards">
          {res.data.tools.map((t) => (
            <li key={`${t.toolKind}:${t.toolId}`} className="card">
              <p className="chain-title">
                <span className="chain-glyph" aria-hidden="true">
                  {kindGlyph(t.kind, t.provider)}
                </span>{" "}
                <PlainText text={t.title} inline /> <span className={BADGE_CLASS[t.badge]}>{BADGE_LABEL[t.badge]}</span>
                {t.effect === "draft_external" ? <span className="pill pill-warn"> drafts only</span> : null}
              </p>
              <p className="role">
                by <PlainText text={t.by} inline />
              </p>
              <p className="small">
                <PlainText text={t.summary} inline />
              </p>
              <p className="small">
                Inputs: {t.io.inputs.map((i) => `${i.name} (${i.kind}${i.required ? "" : ", optional"})`).join(", ")} → output {t.io.output.kind}
              </p>
              <p className="small">
                <Money amount={t.priceBaseUnits} decimals={m.decimalsFor(t.mint, t.network)} /> per step to <Address value={t.recipient} />
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      <Connectors />
      <ConnectTool providers={res.data?.providers ?? []} />
    </>
  );
}

/** Operator-approved remote MCP servers. Each tool is pinned by a digest of its name, description and schema. */
function Connectors() {
  const m = useMarket();
  const res = useResource(() => (m.configured ? marketApi<{ connectors: Connector[] }>("/marketplace/connectors") : Promise.resolve({ connectors: [] })), "mcp-connectors");
  return (
    <Section title="MCP connectors">
      <p className="small">
        Remote MCP servers the operator reviewed. A seller sells one pinned, read-only tool from its own seller host; if the server changes that tool, it is disabled until reviewed
        again.
      </p>
      <ErrorNotice error={res.error} what="connectors could not be loaded" />
      {res.data && res.data.connectors.length === 0 ? <p className="small muted">No connectors are approved yet.</p> : null}
      <ul>
        {(res.data?.connectors ?? []).map((c) => (
          <li key={c.id}>
            <PlainText text={c.title} inline /> — <span className="mono">{c.endpoint}</span>: {c.tools.map((t) => t.name).join(", ")}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ConnectTool({ providers }: { providers: ToolsResponse["providers"] }) {
  return (
    <Section title="Connect your own tool">
      <RequireMarketSession what="connect a tool">
        <ProviderToolForm providers={providers} />
        <McpToolForm />
        <ConnectorProposalForm />
        <ExternalToolForm />
      </RequireMarketSession>
    </Section>
  );
}

/** Pins one approved connector tool to a pending remote listing version; the step input fills {{input}}. */
function McpToolForm() {
  const m = useMarket();
  const id = useId();
  const dash = useResource(() => m.call<SellerDashboard>("/seller/dashboard"), "mcp-seller-dashboard");
  const conns = useResource(() => marketApi<{ connectors: Connector[] }>("/marketplace/connectors"), "mcp-connectors-form");
  const act = useAction();
  const [versionId, setVersionId] = useState("");
  const [choice, setChoice] = useState("");
  const [args, setArgs] = useState('{"ids": "{{input}}"}');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const pending = (dash.data?.versions ?? []).filter((v) => v.review_status === "pending" && v.runtime_kind === "remote_endpoint");
  const options = (conns.data?.connectors ?? []).flatMap((c) => c.tools.map((t) => ({ key: `${c.id}:${t.name}`, connectorId: c.id, toolName: t.name })));
  return (
    <form
      className="stack"
      aria-labelledby={`${id}-h`}
      onSubmit={async (e) => {
        e.preventDefault();
        const o = options.find((x) => x.key === choice);
        let argsTemplate: unknown;
        try {
          argsTemplate = JSON.parse(args);
        } catch {
          setProblem("Arguments must be JSON.");
          return;
        }
        if (!o) return;
        setProblem(null);
        if (await act.run(() => m.call(`/seller/versions/${versionId}/mcp-tool`, { method: "POST", body: { connectorId: o.connectorId, toolName: o.toolName, argsTemplate } }))) setDone(true);
      }}
    >
      <h3 id={`${id}-h`}>MCP tool on your own host</h3>
      <p className="small">
        Allow the connector's endpoint in your seller host (SELLER_HOST_MCP_ENDPOINTS); a bearer key, if the server needs one, stays in that host's environment.
      </p>
      <ErrorNotice error={act.error} what="the MCP tool could not be pinned" />
      {problem ? <p className="field-error">{problem}</p> : null}
      {done ? (
        <p className="notice notice-help" role="status">
          Pinned. Submit the version for review.
        </p>
      ) : (
        <>
          <div className="field">
            <label htmlFor={`${id}-v`}>Pending remote listing version</label>
            <Select
              id={`${id}-v`}
              label="Pending remote listing version"
              required
              value={versionId}
              options={[{ value: "", label: "Choose a version" }, ...pending.map((v) => ({ value: v.id, label: `${v.title} (v${v.version_no})` }))]}
              onChange={setVersionId}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-t`}>Connector tool</label>
            <Select
              id={`${id}-t`}
              label="Connector tool"
              required
              value={choice}
              options={[{ value: "", label: "Choose a tool" }, ...options.map((o) => ({ value: o.key, label: `${o.connectorId}: ${o.toolName}` }))]}
              onChange={setChoice}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-a`}>Arguments (JSON; use "{"{{input}}"}" for the step input)</label>
            <textarea id={`${id}-a`} rows={3} value={args} onChange={(e) => setArgs(e.target.value)} spellCheck={false} />
          </div>
          <button type="submit" className="btn" disabled={act.busy || versionId === "" || choice === ""}>
            Pin MCP tool
          </button>
        </>
      )}
    </form>
  );
}

/** Proposes a remote MCP server; nothing is contacted until the operator verifies and approves it. */
function ConnectorProposalForm() {
  const m = useMarket();
  const id = useId();
  const act = useAction();
  const [json, setJson] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <form
      className="stack"
      aria-labelledby={`${id}-h`}
      onSubmit={async (e) => {
        e.preventDefault();
        let body: unknown;
        try {
          body = JSON.parse(json);
        } catch {
          setProblem("The proposal must be JSON.");
          return;
        }
        setProblem(null);
        const r = await act.run(() => m.call<{ connectorId: string }>("/tools/connectors", { method: "POST", body }));
        if (r) setDone(r.connectorId);
      }}
    >
      <h3 id={`${id}-h`}>Propose an MCP server</h3>
      <p className="small">{'JSON: {"id", "title", "endpoint" (public https), "tools": [{"name", "description", "inputSchema"}]} copied from its tools/list. Read-only tools only.'}</p>
      <ErrorNotice error={act.error} what="the proposal was refused" />
      {problem ? <p className="field-error">{problem}</p> : null}
      {done ? (
        <p className="notice notice-help" role="status">
          Proposed {done}. Status: In review.
        </p>
      ) : (
        <>
          <label htmlFor={`${id}-j`} className="sr-only">
            Connector proposal JSON
          </label>
          <textarea id={`${id}-j`} rows={6} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
          <button type="submit" className="btn" disabled={act.busy || json.trim() === ""}>
            Propose connector
          </button>
        </>
      )}
    </form>
  );
}

/** Pins a provider adapter to one of your pending remote listing versions; the key stays on your host. */
function ProviderToolForm({ providers }: { providers: ToolsResponse["providers"] }) {
  const m = useMarket();
  const dash = useResource(() => m.call<SellerDashboard>("/seller/dashboard"), "tool-seller-dashboard");
  const act = useAction();
  const [versionId, setVersionId] = useState("");
  const [choice, setChoice] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const id = useId();
  const pending = (dash.data?.versions ?? []).filter((v) => v.review_status === "pending" && v.runtime_kind === "remote_endpoint");
  const options = providers.flatMap((p) => p.tools.map((t) => ({ key: `${p.provider}:${t.name}`, provider: p.provider, tool: t })));
  return (
    <form
      className="stack"
      aria-labelledby={`${id}-h`}
      onSubmit={async (e) => {
        e.preventDefault();
        const o = options.find((x) => x.key === choice);
        if (!o) return;
        const r = await act.run(() =>
          m.call<{ manifestSha256: string }>(`/seller/versions/${versionId}/tool-profile`, {
            method: "POST",
            body: { toolKind: "provider_adapter", provider: o.provider, toolName: o.tool.name, effect: o.tool.effect, io: o.tool.io },
          }),
        );
        if (r) setDone(r.manifestSha256);
      }}
    >
      <h3 id={`${id}-h`}>Provider tool on your own host (bring your own key)</h3>
      <ol className="small">
        <li>Create a remote listing in the Seller console that points at your public https seller host.</li>
        <li>Run the seller-host profile with your provider key in its own environment; the key never leaves that process.</li>
        <li>Ask the operator for a scoped host credential (pnpm marketplace:operator host-credential).</li>
        <li>Pin the provider tool below, then submit the version for review.</li>
      </ol>
      <ErrorNotice error={dash.error ?? act.error} what="the tool could not be pinned" />
      {done ? (
        <p className="notice notice-help" role="status">
          Pinned to manifest <span className="mono">{done.slice(0, 16)}…</span>. Submit the version for review; until your host reports the provider as configured it shows “Provider not
          configured”.
        </p>
      ) : (
        <>
          <div className="field">
            <label htmlFor={`${id}-v`}>Pending remote listing version</label>
            <Select
              id={`${id}-v`}
              label="Pending remote listing version"
              required
              value={versionId}
              options={[{ value: "", label: "Choose a version" }, ...pending.map((v) => ({ value: v.id, label: `${v.title} (v${v.version_no})` }))]}
              onChange={setVersionId}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-t`}>Provider tool</label>
            <Select
              id={`${id}-t`}
              label="Provider tool"
              required
              value={choice}
              options={[
                { value: "", label: "Choose a tool" },
                ...options.map((o) => ({ value: o.key, label: `${o.provider}: ${o.tool.name} (${o.tool.effect === "draft_external" ? "drafts only" : "read-only"})` })),
              ]}
              onChange={setChoice}
            />
          </div>
          <button type="submit" className="btn" disabled={act.busy || versionId === "" || choice === ""}>
            Pin provider tool
          </button>
        </>
      )}
    </form>
  );
}

/** Proposes an external x402 resource; the operator reviews it before any workflow can use it. */
function ExternalToolForm() {
  const m = useMarket();
  const act = useAction();
  const id = useId();
  const [json, setJson] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <form
      className="stack"
      aria-labelledby={`${id}-h`}
      onSubmit={async (e) => {
        e.preventDefault();
        let body: unknown;
        try {
          body = JSON.parse(json);
        } catch {
          setProblem("The proposal must be JSON.");
          return;
        }
        setProblem(null);
        const r = await act.run(() => m.call<{ toolId: string }>("/tools/external", { method: "POST", body }));
        if (r) setDone(r.toolId);
      }}
    >
      <h3 id={`${id}-h`}>External x402 resource</h3>
      <p className="small">
        Describe the exact origin, path, recipient and its token account, unit price, calls per step, allowed fee payers and methods, and the call template. Devnet and the pinned test
        mint only; the operator reviews it before it appears here.
      </p>
      <ErrorNotice error={act.error} what="the proposal was refused" />
      {problem ? <p className="field-error">{problem}</p> : null}
      {done ? (
        <p className="notice notice-help" role="status">
          Proposed. Status: In review (tool {done.slice(0, 8)}).
        </p>
      ) : (
        <>
          <label htmlFor={`${id}-j`} className="sr-only">
            Proposal JSON
          </label>
          <textarea id={`${id}-j`} rows={8} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
          <button type="submit" className="btn" disabled={act.busy || json.trim() === ""}>
            Propose for review
          </button>
        </>
      )}
    </form>
  );
}
