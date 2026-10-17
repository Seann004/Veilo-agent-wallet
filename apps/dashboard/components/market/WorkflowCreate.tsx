"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import {
  checkWorkflowPublication,
  compatible,
  toolKey,
  type StepInput,
  type ToolFacts,
  type WorkflowCategory,
  type WorkflowVersionInput,
} from "@veilo/contracts/marketplace";
import { api } from "../../lib/api";
import { marketApi } from "../../lib/market/client";
import type { SellerDashboard } from "../../lib/market/types";
import { BADGE_CLASS, BADGE_LABEL, CATEGORIES, WORKFLOW_STATUS_LABEL, type LocalRun, type ToolEntry } from "../../lib/market/workflows";
import type { Workspace } from "../../lib/types";
import { useAction, useResource } from "../hooks";
import { ErrorNotice, Loading, Section } from "../ui";
import { useMarket } from "./MarketContext";
import { Address, Money, PlainText, RequireMarketSession, TestTokenNote } from "./parts";

interface DraftStep {
  tool: ToolEntry;
  inputs: Record<string, StepInput>;
}

interface Basics {
  slug: string;
  category: WorkflowCategory;
  title: string;
  summary: string;
  description: string;
  safetyPromise: string;
  runInputs: Array<{ name: string; label: string; maxChars: number }>;
}

const STAGES = ["Basics", "Chain", "Price and payout", "Test run", "Publish"] as const;

function facts(tools: ToolEntry[]): Map<string, ToolFacts> {
  return new Map(
    tools.map((t) => [
      toolKey(t.toolKind, t.toolId),
      {
        toolKind: t.toolKind,
        toolId: t.toolId,
        current: t.badge !== "in_review",
        reviewStatus: t.badge === "in_review" ? "pending" : "approved",
        listingStatus: t.badge === "in_review" ? "in_review" : t.badge === "suspended" || t.badge === "manifest_changed" ? "suspended" : "published",
        priceBaseUnits: BigInt(t.priceBaseUnits),
        recipient: t.recipient,
        effect: t.effect,
        io: t.io,
      } satisfies ToolFacts,
    ]),
  );
}

/** Five-step builder for any signed-in creator. Publishing is instant only when every tool is already approved. */
export function WorkflowCreate() {
  return (
    <>
      <h1>Create a workflow</h1>
      <p className="small">Chain published tools into a workflow anyone can run. Each step stays its own purchase paid directly to that tool's recipient.</p>
      <TestTokenNote />
      <RequireMarketSession what="create a workflow">
        <Wizard />
      </RequireMarketSession>
      <MyWorkflows />
    </>
  );
}

function Wizard() {
  const m = useMarket();
  const id = useId();
  const tools = useResource(() => marketApi<{ tools: ToolEntry[] }>("/marketplace/tools"), "create-tools");
  const dash = useResource(() => m.call<SellerDashboard>("/seller/dashboard"), "create-seller");
  const act = useAction();
  const [stage, setStage] = useState(0);
  const [basics, setBasics] = useState<Basics>({ slug: "", category: "research", title: "", summary: "", description: "", safetyPromise: "", runInputs: [{ name: "topic", label: "Topic", maxChars: 500 }] });
  const [steps, setSteps] = useState<DraftStep[]>([]);
  const [payoutVersionId, setPayout] = useState("");
  const [sample, setSample] = useState("");
  const [created, setCreated] = useState<{ workflowId: string; versionId: string; decision: string } | null>(null);
  const [published, setPublished] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  const all = tools.data?.tools ?? [];
  const usable = all.filter((t) => t.badge !== "suspended" && t.badge !== "manifest_changed");
  const total = steps.reduce((n, s) => n + BigInt(s.tool.priceBaseUnits), 0n);
  const verified = (dash.data?.payouts ?? []).filter((p) => p.verified_at);
  const input: WorkflowVersionInput = useMemo(
    () => ({
      category: basics.category,
      title: basics.title,
      summary: basics.summary,
      description: basics.description,
      safetyPromise: basics.safetyPromise,
      runInputs: basics.runInputs.filter((r) => r.name !== ""),
      steps: steps.map((s) => ({ toolKind: s.tool.toolKind, toolId: s.tool.toolId, maxBaseUnits: s.tool.priceBaseUnits, inputs: s.inputs })),
      totalMaxBaseUnits: total.toString(),
      payoutVersionId: payoutVersionId || "00000000-0000-4000-8000-000000000000",
      sampleOutput: sample.trim() === "" ? null : sample,
    }),
    [basics, steps, total, payoutVersionId, sample],
  );
  const preview = steps.length > 0 ? checkWorkflowPublication(input, facts(all), payoutVersionId !== "") : null;
  const decimals = all[0] ? m.decimalsFor(all[0].mint, all[0].network) : null;

  if (tools.loading && !tools.data) return <Loading label="tool library" />;
  return (
    <Section title={`Step ${stage + 1} of 5: ${STAGES[stage]}`}>
      <ol className="wizard-stages" aria-label="Builder steps">
        {STAGES.map((s, i) => (
          <li key={s} aria-current={i === stage ? "step" : undefined} className={i === stage ? "stage stage-active" : "stage"}>
            {s}
          </li>
        ))}
      </ol>
      <ErrorNotice error={tools.error ?? dash.error ?? act.error} what="the builder could not continue" />

      {stage === 0 ? (
        <div className="stack">
          {(["slug", "title", "summary"] as const).map((k) => (
            <div className="field" key={k}>
              <label htmlFor={`${id}-${k}`}>{k === "slug" ? "URL name (lowercase, hyphens)" : k[0]!.toUpperCase() + k.slice(1)}</label>
              <input id={`${id}-${k}`} value={basics[k]} maxLength={k === "summary" ? 200 : 80} onChange={(e) => setBasics({ ...basics, [k]: e.target.value })} />
            </div>
          ))}
          <div className="field">
            <label htmlFor={`${id}-cat`}>Category</label>
            <select id={`${id}-cat`} value={basics.category} onChange={(e) => setBasics({ ...basics, category: e.target.value as WorkflowCategory })}>
              {CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-desc`}>Description</label>
            <textarea id={`${id}-desc`} rows={4} maxLength={4000} value={basics.description} onChange={(e) => setBasics({ ...basics, description: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-safe`}>Safety promise (required when a step drafts posts)</label>
            <input id={`${id}-safe`} maxLength={160} placeholder="Drafts only; nothing posts without your approval." value={basics.safetyPromise} onChange={(e) => setBasics({ ...basics, safetyPromise: e.target.value })} />
          </div>
          <fieldset>
            <legend>What the buyer enters when running it</legend>
            {basics.runInputs.map((r, i) => (
              <div className="field" key={i}>
                <label htmlFor={`${id}-ri-${i}`}>Input {i + 1} label</label>
                <input
                  id={`${id}-ri-${i}`}
                  value={r.label}
                  maxLength={80}
                  onChange={(e) => {
                    const label = e.target.value;
                    const name = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^([0-9])/, "x$1").slice(0, 40);
                    setBasics({ ...basics, runInputs: basics.runInputs.map((x, j) => (j === i ? { ...x, label, name } : x)) });
                  }}
                />
              </div>
            ))}
            {basics.runInputs.length < 4 ? (
              <button type="button" className="btn btn-small" onClick={() => setBasics({ ...basics, runInputs: [...basics.runInputs, { name: "", label: "", maxChars: 500 }] })}>
                Add an input
              </button>
            ) : null}
          </fieldset>
        </div>
      ) : null}

      {stage === 1 ? (
        <div className="stack">
          <ol className="chain">
            {steps.map((s, i) => (
              <li key={i} className="chain-step">
                <p className="chain-title">
                  Step {i + 1}: <PlainText text={s.tool.title} inline /> <span className={BADGE_CLASS[s.tool.badge]}>{BADGE_LABEL[s.tool.badge]}</span> — max{" "}
                  <Money amount={s.tool.priceBaseUnits} decimals={decimals} />
                </p>
                {s.tool.io.inputs.map((want) => {
                  const fieldId = `${id}-s${i}-${want.name}`;
                  const src = s.inputs[want.name];
                  const value = !src ? "" : src.from === "fixed" ? "fixed" : src.from === "run_input" ? `run:${src.name}` : `step:${src.step}`;
                  return (
                    <div className="field" key={want.name}>
                      <label htmlFor={fieldId}>
                        {want.name} ({want.kind}
                        {want.required ? "" : ", optional"})
                      </label>
                      <select
                        id={fieldId}
                        value={value}
                        onChange={(e) => {
                          const v = e.target.value;
                          const next: StepInput | undefined =
                            v === "" ? undefined : v === "fixed" ? { from: "fixed", value: "" } : v.startsWith("run:") ? { from: "run_input", name: v.slice(4) } : { from: "step", step: Number(v.slice(5)) };
                          const inputs = { ...s.inputs };
                          if (next) inputs[want.name] = next;
                          else delete inputs[want.name];
                          setSteps(steps.map((x, j) => (j === i ? { ...x, inputs } : x)));
                        }}
                      >
                        <option value="">Not mapped</option>
                        <option value="fixed">Fixed text</option>
                        {basics.runInputs
                          .filter((r) => r.name !== "")
                          .map((r) => (
                            <option key={r.name} value={`run:${r.name}`}>
                              Buyer input: {r.label}
                            </option>
                          ))}
                        {steps.slice(0, i).map((prev, k) =>
                          compatible(prev.tool.io.output.kind, want.kind) ? (
                            <option key={k} value={`step:${k}`}>
                              Output of step {k + 1} ({prev.tool.io.output.kind})
                            </option>
                          ) : null,
                        )}
                      </select>
                      {src?.from === "fixed" ? (
                        <input
                          aria-label={`${want.name} fixed text`}
                          maxLength={want.maxChars}
                          value={src.value}
                          onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, inputs: { ...x.inputs, [want.name]: { from: "fixed", value: e.target.value } } } : x)))}
                        />
                      ) : null}
                    </div>
                  );
                })}
                <button type="button" className="btn btn-small" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                  Remove step
                </button>
              </li>
            ))}
          </ol>
          {steps.length < 8 ? (
            <div className="field">
              <label htmlFor={`${id}-add`}>Add a step from the tool library</label>
              <select
                id={`${id}-add`}
                value=""
                onChange={(e) => {
                  const t = usable.find((x) => `${x.toolKind}:${x.toolId}` === e.target.value);
                  if (t) setSteps([...steps, { tool: t, inputs: {} }]);
                }}
              >
                <option value="">Choose a tool</option>
                {usable.map((t) => (
                  <option key={`${t.toolKind}:${t.toolId}`} value={`${t.toolKind}:${t.toolId}`}>
                    {t.title} — {BADGE_LABEL[t.badge]}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <p className="small">
            Each step's maximum is the tool's published price, so a run can never pay a step more than the price you see here. <Link href="/marketplace/tools">Connect your own tool</Link>.
          </p>
        </div>
      ) : null}

      {stage === 2 ? (
        <div className="stack">
          <p>
            Price per run: <Money amount={total.toString()} decimals={decimals} /> (the sum of the step prices; zero platform fee).
          </p>
          <div className="field">
            <label htmlFor={`${id}-payout`}>Your verified payout wallet</label>
            <select id={`${id}-payout`} value={payoutVersionId} onChange={(e) => setPayout(e.target.value)}>
              <option value="">Choose a verified wallet</option>
              {verified.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.address}
                </option>
              ))}
            </select>
            {verified.length === 0 ? (
              <p className="hint">
                Prove a payout wallet in the <Link href="/marketplace/seller">Seller console</Link> first.
              </p>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor={`${id}-sample`}>Sample output (optional, shown as plain text)</label>
            <textarea id={`${id}-sample`} rows={4} maxLength={4000} value={sample} onChange={(e) => setSample(e.target.value)} />
          </div>
        </div>
      ) : null}

      {stage === 3 ? (
        <TestRun
          created={created}
          onCreate={async () => {
            setProblems([]);
            const wf = created ?? (await (async () => {
              const w = await act.run(() => m.call<{ workflowId: string }>("/creator/workflows", { method: "POST", body: { slug: basics.slug, category: basics.category } }));
              if (!w) return null;
              const v = await act.run(() => m.call<{ versionId: string; decision: string; problems?: string[] }>(`/creator/workflows/${w.workflowId}/versions`, { method: "POST", body: input }));
              if (!v) return null;
              return { workflowId: w.workflowId, versionId: v.versionId, decision: v.decision };
            })());
            if (wf) setCreated(wf);
          }}
          busy={act.busy}
        />
      ) : null}

      {stage === 4 ? (
        <div className="stack">
          {created ? (
            published ? (
              <p className="notice notice-help" role="status">
                Status: <strong>{published === "live" ? WORKFLOW_STATUS_LABEL.live : WORKFLOW_STATUS_LABEL.in_review}</strong>.{" "}
                {published === "live" ? <Link href={`/marketplace/w/${encodeURIComponent(basics.slug)}`}>Open it in the marketplace</Link> : "A tool in this workflow is still in review."}
              </p>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={act.busy}
                onClick={async () => {
                  const r = await act.run(() => m.call<{ status: string }>(`/creator/versions/${created.versionId}/publish`, { method: "POST", body: {} }));
                  if (r) setPublished(r.status);
                }}
              >
                Publish ({created.decision === "live" ? "goes live now: every tool is approved" : "goes to review: a tool is still in review"})
              </button>
            )
          ) : (
            <p className="small">Save the draft in the test-run step first.</p>
          )}
        </div>
      ) : null}

      {preview && preview.problems.length > 0 ? (
        <div className="notice notice-warn" role="note">
          <p>Publication checks:</p>
          <ul>
            {[...preview.problems, ...problems].map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="actions">
        <button type="button" className="btn" disabled={stage === 0} onClick={() => setStage(stage - 1)}>
          Back
        </button>
        <button type="button" className="btn btn-primary" disabled={stage === 4 || (stage === 1 && steps.length === 0) || (stage === 3 && !created)} onClick={() => setStage(stage + 1)}>
          Next
        </button>
      </div>
      {payoutVersionId ? (
        <p className="small">
          Payout wallet: <Address value={verified.find((p) => p.id === payoutVersionId)?.address ?? null} />
        </p>
      ) : null}
    </Section>
  );
}

/** Saves the draft, then runs it once for real on devnet from the creator's own wallet, marked as a test. */
function TestRun({ created, onCreate, busy }: { created: { versionId: string; decision: string } | null; onCreate: () => void; busy: boolean }) {
  const ws = useResource(() => api<Workspace>("control", "/workspace"), "create-test-agents");
  const act = useAction();
  const [agentId, setAgentId] = useState("");
  const [inputs, setInputs] = useState("{}");
  const [run, setRun] = useState<LocalRun | null>(null);
  const id = useId();
  if (!created) {
    return (
      <div className="stack">
        <p>Save the workflow as a draft first. Nothing is published yet.</p>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onCreate}>
          Save draft
        </button>
      </div>
    );
  }
  return (
    <div className="stack">
      <p>
        Draft saved. A test run is a real paid run on devnet from your own local wallet, marked as a test; it is optional and does not count as a paid run in the catalogue.
      </p>
      <ErrorNotice error={ws.error ?? act.error} what="the test run could not start (sign in to the local dashboard first)" />
      {run ? (
        <p className="notice notice-help" role="status">
          Test run prepared. <Link href={`/marketplace/runs/${run.id}`}>Review and approve it</Link>.
        </p>
      ) : (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            let runInputs: Record<string, string>;
            try {
              runInputs = JSON.parse(inputs) as Record<string, string>;
            } catch {
              return;
            }
            const r = await act.run(() => api<{ run: LocalRun }>("control", "/workflows/runs", { method: "POST", body: { versionId: created.versionId, agentId, runInputs, isTest: true } }));
            if (r) setRun(r.run);
          }}
        >
          <div className="field">
            <label htmlFor={`${id}-a`}>Agent whose budget pays</label>
            <select id={`${id}-a`} required value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">Choose an agent</option>
              {(ws.data?.agents ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-i`}>Buyer inputs (JSON)</label>
            <textarea id={`${id}-i`} rows={3} value={inputs} onChange={(e) => setInputs(e.target.value)} spellCheck={false} />
          </div>
          <button type="submit" className="btn" disabled={act.busy || agentId === ""}>
            Prepare test run
          </button>
        </form>
      )}
    </div>
  );
}

function MyWorkflows() {
  const m = useMarket();
  const mine = useResource(
    () => (m.me ? m.call<{ workflows: Array<{ id: string; slug: string; status: string; demo: boolean }>; versions: Array<{ id: string; workflow_id: string; version_no: number; title: string; review_status: string }> }>("/creator/workflows") : Promise.resolve(null)),
    `my-workflows:${m.me ? "in" : "out"}`,
  );
  if (!mine.data || mine.data.workflows.length === 0) return null;
  return (
    <Section title="Your workflows">
      <ul>
        {mine.data.workflows.map((w) => (
          <li key={w.id}>
            <span className="mono">{w.slug}</span> <span className="pill">{WORKFLOW_STATUS_LABEL[w.status] ?? w.status}</span>
            {w.status === "live" ? (
              <>
                {" "}
                <Link href={`/marketplace/w/${encodeURIComponent(w.slug)}`}>open</Link>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}
