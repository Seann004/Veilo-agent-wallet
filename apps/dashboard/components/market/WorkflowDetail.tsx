"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { api } from "../../lib/api";
import { parseUnits } from "../../lib/market/amounts";
import { marketApi } from "../../lib/market/client";
import { localControllerStatus } from "../../lib/market/controller-registration";
import { categoryLabel, hiringAgents, kindGlyph, workflowAgents, type LocalRun, type WorkflowEntry } from "../../lib/market/workflows";
import type { Workspace } from "../../lib/types";
import { useAction, useResource } from "../hooks";
import { ConfirmButton, ErrorNotice, KV, Loading } from "../ui";
import { useMarket } from "./MarketContext";
import { Address, creatorAvatar, DetailHeader, DetailSections, FullValue, Money, PlainText, TestTokenNote, type DetailSection } from "./parts";
import { Select } from "../Select";

function willAndWont(w: WorkflowEntry): { will: string[]; wont: string[] } {
  const drafts = w.steps.some((s) => s.effect === "draft_external");
  return {
    will: [
      `Buy ${w.steps.length} step${w.steps.length === 1 ? "" : "s"} in order, each as its own payment to the recipient shown`,
      "Stop before paying any step whose price or recipient changed",
      "Pass earlier outputs to later steps only as stored data",
      ...(drafts ? ["Prepare a draft you can review"] : []),
    ],
    wont: [
      "Spend more than the total you approve",
      "Post, publish or send anything on your behalf",
      "Buy later steps after a step fails or is uncertain",
      "Charge a platform fee",
    ],
  };
}

/** One live workflow: its chain, prices and recipients, and the two ways to use it. */
export function WorkflowDetail({ slug }: { slug: string }) {
  const m = useMarket();
  const [open, setOpen] = useState("about");
  const res = useResource(() => marketApi<{ workflow: WorkflowEntry }>(`/marketplace/workflows/${encodeURIComponent(slug)}`), `workflow:${slug}`);
  if (res.loading && !res.data) return <Loading label="workflow" />;
  if (res.error || !res.data) return <ErrorNotice error={res.error} what="this workflow could not be loaded" onRetry={res.reload} />;
  const w = res.data.workflow;
  const decimals = m.decimalsFor(w.mint, w.network);
  const ww = willAndWont(w);
  const unavailable = w.steps.filter((s) => s.providerStatus === "not_configured" || s.providerStatus === "unknown" || s.providerStatus === "manifest_changed");
  const sections: DetailSection[] = [
    {
      id: "about",
      label: "About",
      sub: "What it does and won't do",
      body: (
        <div className="stack">
          <PlainText text={w.description ?? w.summary} />
          {w.safety_promise ? (
            <p className="notice notice-help">
              <PlainText text={w.safety_promise} inline />
            </p>
          ) : null}
          {unavailable.length > 0 ? (
            <p className="notice notice-warn" role="note">
              {unavailable.length} step{unavailable.length === 1 ? " uses a provider" : "s use providers"} that the seller has not configured or that need re-review. Those steps
              cannot be quoted, so a run stops before paying them.
            </p>
          ) : null}
          <div className="grid-2">
            <div>
              <h3>It will</h3>
              <ul>
                {ww.will.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3>It won't</h3>
              <ul>
                {ww.wont.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          </div>
          <p className="small muted">
            {categoryLabel(w.category)} · {w.paid_runs} paid run{w.paid_runs === 1 ? "" : "s"}
          </p>
        </div>
      ),
    },
    {
      id: "steps",
      label: "Steps",
      sub: `${w.steps.length} paid tool${w.steps.length === 1 ? "" : "s"} in order`,
      body: (
        <>
          <ol className="chain" aria-label="Tool chain">
            {w.steps.map((s) => (
              <li key={s.index} className="chain-step">
                <span className="chain-glyph" aria-hidden="true">
                  {kindGlyph(s.kind, s.provider)}
                </span>
                <div>
                  <p className="chain-title">
                    Step {s.index + 1}: <PlainText text={s.title ?? "Unknown tool"} inline /> {s.effect === "draft_external" ? <span className="pill pill-warn">drafts only</span> : null}
                    {s.providerStatus === "not_configured" || s.providerStatus === "unknown" ? <span className="pill pill-muted">Provider not configured</span> : null}
                    {s.providerStatus === "manifest_changed" ? <span className="pill pill-danger">Manifest changed</span> : null}
                  </p>
                  <KV
                    rows={[
                      ["By", <PlainText key="by" text={s.sellerName ?? "—"} inline />],
                      ["Up to", <Money key="p" compact amount={s.priceBaseUnits} decimals={decimals} />],
                      ["Paid to", s.recipient ? <Address key="r" value={s.recipient} /> : "—"],
                    ]}
                  />
                </div>
              </li>
            ))}
          </ol>
          <p className="workflow-total">
            Total per run: <Money amount={String(w.total_base_units)} decimals={decimals} /> · Platform fee: {w.fee_bps === 0 ? "none" : <span className="pill pill-danger">{w.fee_bps} bps</span>}
          </p>
        </>
      ),
    },
    { id: "run", label: "Run once", sub: "Approve one run and its total", body: <RunOnce w={w} /> },
    { id: "add", label: "Add to an agent", sub: "Let an agent use it within a budget", body: <AddToAgent w={w} /> },
    ...(w.sample_output
      ? [
          {
            id: "sample",
            label: "Sample",
            sub: "Example output from the creator",
            body: (
              <pre className="plain-text">
                <PlainText text={w.sample_output} />
              </pre>
            ),
          },
        ]
      : []),
  ];
  return (
    <>
      <DetailHeader
        avatar={creatorAvatar(w.title)}
        title={w.title}
        by={`${w.creator_name}${w.demo ? " (demo)" : ""}`}
        summary={w.summary}
        actions={
          <>
            <button type="button" className="btn btn-primary btn-pill" onClick={() => setOpen("run")}>
              Run once · <Money compact amount={String(w.total_base_units)} decimals={decimals} />
            </button>
            <button type="button" className="btn btn-pill" onClick={() => setOpen("add")}>
              Add to an agent
            </button>
          </>
        }
      />
      <TestTokenNote />
      <DetailSections sections={sections} open={open} onOpen={setOpen} />
    </>
  );
}

function useAgents() {
  return useResource(() => api<Workspace>("control", "/workspace"), "workflow-agents");
}

/** Prepares the exact terms locally, shows them, and approves their digest. */
function RunOnce({ w }: { w: WorkflowEntry }) {
  const router = useRouter();
  const ws = useAgents();
  const controller = useResource(localControllerStatus, "local-controller");
  const unlinked = controller.data !== undefined && (!controller.data.configured || controller.data.registration === null);
  const act = useAction();
  const [agentId, setAgentId] = useState("");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [prepared, setPrepared] = useState<LocalRun | null>(null);
  const formId = useId();
  const agents = hiringAgents(ws.data?.agents ?? []);
  const agentOptions = [{ value: "", label: "Choose an agent" }, ...agents.map((a) => ({ value: a.id, label: a.name }))];
  return (
    <div className="stack">
      <p className="small">Nothing is paid until you approve the exact steps and total.</p>
      {unlinked ? (
        <div className="notice notice-warn" role="status">
          <p className="flush">
            Link this computer&apos;s controller to your marketplace account first. It authorizes every step&apos;s payment.{" "}
            <Link href="/marketplace/agents">Link it under Marketplace → Agents</Link>
          </p>
        </div>
      ) : null}
      <ErrorNotice error={ws.error} what="your local agents could not be loaded (sign in to the local dashboard first)" />
      <ErrorNotice error={act.error} what="the run could not be prepared or approved" />
      {!prepared ? (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await act.run(() => api<{ run: LocalRun }>("control", "/workflows/runs", { method: "POST", body: { versionId: w.version_id, agentId, runInputs: inputs } }));
            if (r) setPrepared(r.run);
          }}
        >
          <div className="field">
            <label htmlFor={`${formId}-agent`}>Which agent&apos;s limits cover this run</label>
            <Select id={`${formId}-agent`} label="Which agent's limits cover this run" required value={agentId} options={agentOptions} onChange={setAgentId} />
            <p className="hint">Paid from your private pool. Only agents that are on and allowed to hire appear here.</p>
            {ws.data && agents.length === 0 ? (
              <p className="notice notice-warn" role="note">
                No agent can hire yet. <Link href="/agents/new">Create an agent</Link> that is allowed to hire specialists, and turn it on.
              </p>
            ) : null}
          </div>
          {(w.run_inputs ?? []).map((ri) => (
            <div className="field" key={ri.name}>
              <label htmlFor={`${formId}-${ri.name}`}>
                <PlainText text={ri.label} inline />
              </label>
              <input id={`${formId}-${ri.name}`} required maxLength={ri.maxChars} value={inputs[ri.name] ?? ""} onChange={(e) => setInputs({ ...inputs, [ri.name]: e.target.value })} />
            </div>
          ))}
          <button type="submit" className="btn btn-primary" disabled={act.busy || agentId === ""}>
            Prepare run
          </button>
        </form>
      ) : (
        <RunTermsView run={prepared} w={w} onApprove={async () => {
          const r = await act.run(() => api<{ run: LocalRun }>("control", `/workflows/runs/${prepared.id}/approve`, { method: "POST", body: { approvalDigest: prepared.approvalDigest } }));
          if (r) router.push(`/marketplace/runs/${r.run.id}`);
        }} busy={act.busy} />
      )}
    </div>
  );
}

export function RunTermsView({ run, w, onApprove, busy }: { run: LocalRun; w: WorkflowEntry; onApprove: () => void; busy: boolean }) {
  const m = useMarket();
  const decimals = m.decimalsFor(w.mint, w.network);
  return (
    <div className="stack local-approval">
      <p className="small flush">You approve these exact steps. If a price changes, the run stops and asks again.</p>
      <div className="table-wrap">
        <table className="terms-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">What</th>
              <th scope="col">Paid to</th>
              <th scope="col" className="num">
                Up to (USDC)
              </th>
            </tr>
          </thead>
          <tbody>
            {run.terms.steps.map((s, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{w.steps[i]?.title ? <PlainText text={w.steps[i]!.title ?? ""} inline /> : `Step ${i + 1}`}</td>
                <td>
                  <Address value={s.recipient} />
                </td>
                <td className="num">
                  <Money compact amount={s.maxBaseUnits} decimals={decimals} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="terms-total">
        Total up to <Money compact amount={run.terms.totalMaxBaseUnits} decimals={decimals} /> · Solana devnet
      </p>
      <details className="tech-details">
        <summary>Technical details</summary>
        <KV
          rows={[
            ["Total (base units)", <span key="tb" className="mono">{run.terms.totalMaxBaseUnits}</span>],
            ...run.terms.steps.map((s, i): [string, React.ReactNode] => [`Step ${i + 1} (base units)`, <span key={i} className="mono">{s.maxBaseUnits} · {s.toolKind}</span>]),
            ["Approval digest", <FullValue key="d" value={run.approvalDigest} />],
          ]}
        />
      </details>
      <ConfirmButton label="Approve and run" confirmLabel="Confirm approval" onConfirm={onApprove} disabled={busy} />
    </div>
  );
}

/** Lets an agent propose runs of this workflow within a budget; only you can set or change it. */
function AddToAgent({ w }: { w: WorkflowEntry }) {
  const m = useMarket();
  const ws = useAgents();
  const act = useAction();
  const [agentId, setAgentId] = useState("");
  const [budget, setBudget] = useState("");
  const [done, setDone] = useState(false);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const formId = useId();
  const decimals = m.decimalsFor(w.mint, w.network);
  const agents = workflowAgents(ws.data?.agents ?? []);
  const agentOptions = [{ value: "", label: "Choose an agent" }, ...agents.map((a) => ({ value: a.id, label: a.name }))];
  return (
    <div className="stack">
      <p className="small">
        The agent can run this workflow on its own, within the budget you set here.
      </p>
      <ErrorNotice error={act.error} what="the assignment could not be saved" />
      {done ? (
        <p className="notice notice-help" role="status">
          Added. The agent can now propose runs within the budget.
        </p>
      ) : (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            let units: string;
            if (decimals === null) {
              if (!/^[1-9][0-9]{0,18}$/.test(budget.trim())) return setBudgetError("enter a whole number of base units");
              units = budget.trim();
            } else {
              const p = parseUnits(budget, decimals);
              if (!p.ok) return setBudgetError(p.error);
              units = p.value;
            }
            setBudgetError(null);
            const r = await act.run(() => api("control", "/workflows/assignments", { method: "POST", body: { agentId, versionId: w.version_id, budgetUsdc: units } }));
            if (r) setDone(true);
          }}
        >
          <div className="field">
            <label htmlFor={`${formId}-agent`}>Agent</label>
            <Select id={`${formId}-agent`} label="Agent" required value={agentId} options={agentOptions} onChange={setAgentId} />
            <p className="hint">Only custom agents that are on and allowed to hire appear here. The agent proposes a run when a task fits; it runs within this budget without asking you again.</p>
            {ws.data && agents.length === 0 ? (
              <p className="notice notice-warn" role="note">
                No agent can take a workflow yet. <Link href="/agents/new">Create a custom agent</Link> that is allowed to hire specialists, and turn it on.
              </p>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor={`${formId}-budget`}>Budget {decimals === null ? "(base units)" : "(USDC)"}</label>
            <input id={`${formId}-budget`} required inputMode="decimal" aria-invalid={budgetError !== null} value={budget} onChange={(e) => setBudget(e.target.value)} />
            {budgetError ? <p className="field-error">{budgetError}</p> : null}
            <p className="hint">
              At least one run: <Money amount={String(w.total_base_units)} decimals={decimals} />
            </p>
          </div>
          <button type="submit" className="btn" disabled={act.busy || agentId === ""}>
            Add to agent
          </button>
        </form>
      )}
    </div>
  );
}
