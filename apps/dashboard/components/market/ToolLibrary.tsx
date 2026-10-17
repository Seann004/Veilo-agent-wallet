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
      <ConnectTool providers={res.data?.providers ?? []} />
    </>
  );
}

function ConnectTool({ providers }: { providers: ToolsResponse["providers"] }) {
  return (
    <Section title="Connect your own tool">
      <RequireMarketSession what="connect a tool">
        <ProviderToolForm providers={providers} />
        <ExternalToolForm />
      </RequireMarketSession>
    </Section>
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
            <select id={`${id}-v`} required value={versionId} onChange={(e) => setVersionId(e.target.value)}>
              <option value="">Choose a version</option>
              {pending.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.title} (v{v.version_no})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-t`}>Provider tool</label>
            <select id={`${id}-t`} required value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">Choose a tool</option>
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.provider}: {o.tool.name} ({o.tool.effect === "draft_external" ? "drafts only" : "read-only"})
                </option>
              ))}
            </select>
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
