"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { api } from "../lib/api";
import { ROLE_LABEL } from "../lib/labels";
import type { Agent, AgentRole } from "../lib/types";
import { draftPolicyFromText, type PolicyDraftResult } from "../lib/policy-draft";
import { CustomAgentFields, EMPTY_CUSTOM, RunnerCredentialNote, grantBody, withHiring, type CustomDraft } from "./CustomAgentFields";
import { PolicyForm, PolicyReview, ROLE_TEMPLATES, type AgentPolicyInput } from "./Policy";
import { useOwner } from "./Shell";
import { useAction } from "./hooks";
import { ErrorNotice, Loading, Section } from "./ui";

/**
 * Create agent: role template, name, job, trigger and model profile, then a structured review.
 * The agent is created with a draft policy and cannot spend until the owner activates it.
 */
export function CreateAgent() {
  const { workspace, reloadWorkspace } = useOwner();
  const [role, setRole] = useState<AgentRole>("research");
  const [name, setName] = useState("");
  const [job, setJob] = useState(ROLE_TEMPLATES.research.description);
  const [modelProfile, setModelProfile] = useState("default");
  const [pollSeconds, setPollSeconds] = useState("60");
  const [policy, setPolicy] = useState<AgentPolicyInput | null>(ROLE_TEMPLATES.research.policy);
  const [base, setBase] = useState<AgentPolicyInput>(ROLE_TEMPLATES.research.policy);
  const [seed, setSeed] = useState(0);
  const [words, setWords] = useState("");
  const [drafted, setDrafted] = useState<PolicyDraftResult | null>(null);
  const wordsId = useId();
  const [created, setCreated] = useState<Agent | null>(null);
  const [custom, setCustom] = useState<CustomDraft>(EMPTY_CUSTOM);
  const [grantsSaved, setGrantsSaved] = useState(false);
  const grantsAction = useAction();
  const [step, setStep] = useState<"edit" | "review">("edit");
  const action = useAction();
  const roleId = useId();
  const nameId = useId();
  const jobId = useId();
  const modelId = useId();
  const pollId = useId();
  const wsPolicy = workspace.policies.find((p) => p.scope === "workspace" && p.status === "active");
  const trigger = role === "credit_manager" ? { type: "low_credit_balance", pollSeconds: Number(pollSeconds) } : { type: "owner_task" };
  const isCustom = role === "custom";
  const effective = policy && isCustom ? withHiring(policy, custom.hiring) : policy;
  const pendingGrants = isCustom && custom.hiring ? custom.grants : [];
  // The allowlist is a separate endpoint, so it is saved after the agent exists and can fail on its own.
  const saveGrants = (agentId: string) =>
    grantsAction.run(async () => {
      await api("control", `/agents/${agentId}/marketplace-allowlist`, { method: "PUT", body: { grants: pendingGrants.map(grantBody) } });
      setGrantsSaved(true);
    });

  if (created) {
    return (
      <Section title={`${created.name} created with draft policy v1`}>
        <p>The agent cannot spend until you activate its policy.</p>
        {pendingGrants.length > 0 ? (
          grantsSaved ? (
            <p role="status" className="small">
              {pendingGrants.length} pre-approved listing(s) saved.
            </p>
          ) : grantsAction.busy ? (
            <Loading label="pre-approved listings" />
          ) : grantsAction.error ? (
            <div className="notice notice-error" role="alert">
              <p>The agent was created, but its pre-approved listings were not saved. Until they are, every hire waits for your approval.</p>
              <ErrorNotice error={grantsAction.error} />
              <button type="button" className="btn" onClick={() => void saveGrants(created.id)}>
                Retry saving pre-approved listings
              </button>
            </div>
          ) : null
        ) : null}
        <button
          type="button"
          className="btn btn-primary"
          disabled={action.busy || created.status === "active"}
          onClick={() =>
            void action.run(async () => {
              await api("control", `/agents/${created.id}/config`, { method: "PATCH", body: { activatePolicyVersion: 1 } });
              await reloadWorkspace();
              setCreated({ ...created, status: "active" });
            })
          }
        >
          Activate {created.name}
        </button>{" "}
        <Link href={`/agents/${created.id}${created.role === "credit_manager" ? "" : "#run"}`}>Open agent</Link>
        {created.status === "active" ? <p role="status">Activated.</p> : null}
        <ErrorNotice error={action.error} />
        {created.role !== "credit_manager" ? <RunnerCredentialNote /> : null}
        {created.role === "custom" && custom.hiring ? (
          <p className="small">
            Hires this agent proposes wait for you in <Link href="/marketplace/approvals">Marketplace → Approvals</Link>.
          </p>
        ) : null}
      </Section>
    );
  }

  return (
    <>
      <h1>Create agent</h1>
      <p className="small">An agent is a record plus a constrained worker under its own policy. It cannot create further spending agents.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (step === "edit") {
            setStep("review");
            return;
          }
          void (async () => {
            const agent = await action.run(async () => {
              const r = await api<{ agent: Agent }>("control", "/agents", {
                method: "POST",
                body: {
                  name,
                  role,
                  description: job,
                  trigger,
                  modelProfile,
                  ...(isCustom ? { template: custom.template, instructions: custom.instructions.trim() } : {}),
                  policy: effective,
                },
              });
              await reloadWorkspace();
              return r.agent;
            });
            if (!agent) return;
            setCreated(agent);
            if (pendingGrants.length > 0) await saveGrants(agent.id);
          })();
        }}
      >
        <fieldset disabled={step === "review"}>
          <legend>Agent</legend>
          <div className="grid-2">
            <div className="field">
              <label htmlFor={roleId}>Role template</label>
              <select
                id={roleId}
                value={role}
                onChange={(e) => {
                  const r = e.target.value as AgentRole;
                  setRole(r);
                  setJob(ROLE_TEMPLATES[r].description);
                  setPolicy(ROLE_TEMPLATES[r].policy);
                  setBase(ROLE_TEMPLATES[r].policy);
                  setDrafted(null);
                }}
              >
                {(Object.keys(ROLE_LABEL) as AgentRole[]).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={nameId}>Name *</label>
              <input id={nameId} required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={jobId}>Job *</label>
              <input id={jobId} required maxLength={500} value={job} onChange={(e) => setJob(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={modelId}>Model profile</label>
              <input id={modelId} maxLength={128} value={modelProfile} onChange={(e) => setModelProfile(e.target.value)} />
            </div>
            {role === "credit_manager" ? (
              <div className="field">
                <label htmlFor={pollId}>Trigger: check every (seconds)</label>
                <input id={pollId} inputMode="numeric" value={pollSeconds} onChange={(e) => setPollSeconds(e.target.value)} />
              </div>
            ) : (
              <p className="small">Trigger: starts when the owner submits a task{role === "content" ? " or approves a research handoff" : ""}.</p>
            )}
          </div>
          {isCustom ? <CustomAgentFields value={custom} onChange={setCustom} /> : null}
          <div className="field">
            <label htmlFor={wordsId}>Describe the limits in words (optional)</label>
            <textarea id={wordsId} rows={2} value={words} onChange={(e) => setWords(e.target.value)} aria-describedby={`${wordsId}-h`} placeholder="Up to 2 USDC in total, 0.5 per purchase, 1 per task" />
            <span id={`${wordsId}-h`} className="hint">
              A rule-based reader, not a model. It only fills the fields below as a draft; nothing is saved or activated until you review it and create the agent.
            </span>
            <div className="actions">
              <button
                type="button"
                className="btn"
                disabled={words.trim() === ""}
                onClick={() => {
                  const r = draftPolicyFromText(words, ROLE_TEMPLATES[role].policy);
                  setDrafted(r);
                  setBase(r.policy);
                  setPolicy(r.policy);
                  setSeed((n) => n + 1);
                }}
              >
                Draft limits from description
              </button>
            </div>
            {drafted ? (
              <p role="status" className="notice small">
                {drafted.understood.length > 0 ? `Filled: ${drafted.understood.join("; ")}.` : "Nothing in the description matched a limit."}
                {drafted.ignored.length > 0 ? ` Not understood, left unchanged: ${drafted.ignored.join("; ")}.` : ""} Check every field below before continuing.
              </p>
            ) : null}
          </div>
          <PolicyForm key={`${role}-${seed}`} initial={base} workspace={workspace} onChange={setPolicy} />
        </fieldset>
        {step === "review" && effective ? (
          <Section title="Review effective policy">
            {isCustom ? <p className="small">Marketplace hiring: {custom.hiring ? `allowed, ${custom.grants.length} pre-approved listing(s)` : "off"}.</p> : null}
            <PolicyReview policy={effective} workspacePolicy={wsPolicy} title={`${name || "New agent"} (draft v1)`} />
            <p className="small">Creating the agent stores this policy as a draft. You activate it in the next step.</p>
          </Section>
        ) : null}
        {!policy ? (
          <p className="notice notice-error" role="alert">
            Fix the policy amounts: use USDC with at most 6 decimals and whole microcredits.
          </p>
        ) : null}
        <div className="actions">
          {step === "review" ? (
            <button type="button" className="btn" onClick={() => setStep("edit")}>
              Back to edit
            </button>
          ) : null}
          <button type="submit" className="btn btn-primary" disabled={!policy || action.busy || name.trim() === "" || (isCustom && custom.instructions.trim() === "")}>
            {step === "edit" ? "Review policy" : "Create agent with draft policy"}
          </button>
        </div>
        <ErrorNotice error={action.error} />
      </form>
    </>
  );
}
