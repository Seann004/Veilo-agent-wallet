"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { api } from "../lib/api";
import { ROLE_AVATAR, avatarById, setAgentAvatar } from "../lib/avatars";
import { resolveAvatar } from "../lib/avatar-customization";
import { HIDDEN_SKUS, ROLE_LABEL, skuGroup } from "../lib/labels";
import { ROLE_TAGLINE } from "../lib/roles";
import type { Agent, AgentRole } from "../lib/types";
import type { AttachOutcome, Connector } from "../lib/connectors";
import { draftPolicyFromText, type PolicyDraftResult } from "../lib/policy-draft";
import { CustomAgentFields, EMPTY_CUSTOM, RunnerCredentialNote, grantBody, withHiring, type CustomDraft } from "./CustomAgentFields";
import { PolicyForm, PolicyReviewGroups, ROLE_TEMPLATES, type AgentPolicyInput } from "./Policy";
import { AvatarImage, AvatarPicker } from "./Avatar";
import { CreateConnectorsStep, CreatedConnectors, attachPicked } from "./AgentConnectors";
import { useCapability, useOwner } from "./Shell";
import { useAction } from "./hooks";
import { ErrorNotice, Loading, Spinner } from "./ui";

/**
 * Create agent: role template, name, job, trigger and model profile, then a structured review.
 * The agent is created with a draft policy and cannot spend until the owner activates it.
 */
export function CreateAgent() {
  const create = useCapability("create");
  if (!create.allowed) {
    return (
      <>
        <div className="page-head">
          <h1>Create agent</h1>
        </div>
        <div className="notice" role="status">
          <p className="flush">
            <strong>Creating agents is owner-only.</strong> {create.reason}
          </p>
          <p className="hint flush">
            <Link href="/workspace">Back to the workspace</Link>
          </p>
        </div>
      </>
    );
  }
  return <CreateAgentForm />;
}

function CreateAgentForm() {
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
  const [avatarId, setAvatarId] = useState(ROLE_AVATAR.research);
  const [avatarChosen, setAvatarChosen] = useState(false);
  const [custom, setCustom] = useState<CustomDraft>(EMPTY_CUSTOM);
  const [grantsSaved, setGrantsSaved] = useState(false);
  const grantsAction = useAction();
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [outcomes, setOutcomes] = useState<AttachOutcome[] | null>(null);
  const action = useAction();
  const nameId = useId();
  const jobId = useId();
  const modelId = useId();
  const pollId = useId();
  const wsPolicy = workspace.policies.find((p) => p.scope === "workspace" && p.status === "active");
  // A new custom agent starts with approved data and AI work only; swaps and hiring move funds
  // differently, so the owner turns those on explicitly.
  const approvedSkus = [...new Set(workspace.services.flatMap((sv) => sv.skus.map((k) => k.sku)))].filter((k) => !HIDDEN_SKUS.has(k) && (skuGroup(k) === "Data" || skuGroup(k) === "AI work")).sort();
  const templateFor = (r: AgentRole): AgentPolicyInput => (r === "custom" && ROLE_TEMPLATES[r].policy.allowedSkus.length === 0 ? { ...ROLE_TEMPLATES[r].policy, allowedSkus: approvedSkus } : ROLE_TEMPLATES[r].policy);
  const chooseRole = (r: AgentRole) => {
    setRole(r);
    setJob(ROLE_TEMPLATES[r].description);
    setPolicy(templateFor(r));
    setBase(templateFor(r));
    setDrafted(null);
    if (!avatarChosen) setAvatarId(ROLE_AVATAR[r]);
  };
  // Marketplace links preselect a role with ?role=; read once on mount.
  useEffect(() => {
    const r = new URLSearchParams(window.location.search).get("role");
    if (r && r in ROLE_TEMPLATES) chooseRole(r as AgentRole);
  }, []);
  const preview = resolveAvatar(avatarId);
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
    const active = created.status === "active";
    return (
      <section className="panel created">
        {preview ? <AvatarImage avatar={preview} size={88} /> : null}
        <h1>{active ? `${created.name} is on` : `${created.name} is ready`}</h1>
        <p className="muted">{active ? "It can now work within the limits you set." : "It can't spend anything until you activate it."}</p>
        <div className="actions">
          {!active ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await api("control", `/agents/${created.id}/config`, { method: "PATCH", body: { activatePolicyVersion: 1 } });
                  await reloadWorkspace();
                  setCreated({ ...created, status: "active" });
                })
              }
            >
              {action.busy ? <Spinner /> : null}
              Activate {created.name}
            </button>
          ) : null}
          <Link className="btn" href={`/agents/${created.id}${created.role === "credit_manager" ? "" : "#run"}`}>
            Open {created.name}
          </Link>
        </div>
        <ErrorNotice error={action.error} />
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
        {created.role !== "credit_manager" ? <RunnerCredentialNote /> : null}
        {created.role === "custom" && custom.hiring ? (
          <p className="small">
            Hires this agent proposes wait for you in <Link href="/marketplace/approvals">Marketplace → Approvals</Link>.
          </p>
        ) : null}
        <CreatedConnectors
          agent={created}
          picked={connectors}
          outcomes={outcomes}
          onRetry={async (retry) => {
            const again = await attachPicked(created.id, retry);
            setOutcomes((prev) => (prev ?? []).map((o) => again.find((x) => x.connectorId === o.connectorId) ?? o));
          }}
        />
      </section>
    );
  }

  const missing =
    name.trim() === ""
      ? "Add a name to continue."
      : job.trim() === ""
        ? "Describe the job to continue."
        : isCustom && custom.instructions.trim() === ""
          ? "Add instructions to continue."
          : !policy
            ? "Fix the highlighted limits to continue."
            : null;

  return (
    <>
      <div className="page-head">
        <h1>Create agent</h1>
      </div>
      <section className="panel" aria-label="Role and avatar">
        <div className="avatar-hero">
          {preview ? <AvatarImage avatar={preview} size={96} /> : null}
          <details className="advanced">
            <summary>Change look</summary>
            <AvatarPicker
              value={avatarId}
              onChange={(id) => {
                setAvatarId(id);
                setAvatarChosen(true);
              }}
            />
          </details>
        </div>
        <h2 className="section-title">Role</h2>
        <div className="suggestions">
          {/* Model work runs on the owner's own key, so there is no credit manager to create. */}
          {(Object.keys(ROLE_LABEL) as AgentRole[]).filter((r) => r !== "credit_manager").map((r) => {
            const a = avatarById(ROLE_AVATAR[r]);
            return (
              <button key={r} type="button" className="suggestion" aria-pressed={role === r} disabled={step === "review"} onClick={() => chooseRole(r)}>
                {a ? <AvatarImage avatar={a} size={44} /> : null}
                <span>
                  <strong>{ROLE_LABEL[r]}</strong>
                  <span className="small muted">{ROLE_TAGLINE[r]}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (missing) return;
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
                  description: isCustom ? (custom.instructions.trim().split("\n")[0]!.slice(0, 500) || job) : job,
                  trigger,
                  modelProfile,
                  ...(isCustom ? { template: custom.template, instructions: custom.instructions.trim() } : {}),
                  policy: effective,
                },
              });
              setAgentAvatar(r.agent.id, avatarId);
              await reloadWorkspace();
              return r.agent;
            });
            if (!agent) return;
            setCreated(agent);
            // The agent exists from here on; grant and attachment failures are reported on their own, not as a create failure.
            if (pendingGrants.length > 0) await saveGrants(agent.id);
            if (connectors.length > 0) setOutcomes(await attachPicked(agent.id, connectors));
          })();
        }}
      >
        {step === "edit" ? (
          <>
            <section className="panel">
              <h2 className="panel-title">Details</h2>
              <div className="grid-2">
                <div className="field">
                  <label htmlFor={nameId}>Name</label>
                  <input id={nameId} required maxLength={64} value={name} placeholder="e.g. Nova" onChange={(e) => setName(e.target.value)} />
                </div>
                {role === "credit_manager" ? (
                  <div className="field">
                    <label htmlFor={pollId}>Check credits every</label>
                    <span className="input-unit">
                      <input id={pollId} inputMode="numeric" value={pollSeconds} onChange={(e) => setPollSeconds(e.target.value)} />
                      <span aria-hidden="true">sec</span>
                    </span>
                  </div>
                ) : (
                  <span />
                )}
              </div>
              {isCustom ? null : (
                <div className="field">
                  <label htmlFor={jobId}>Job</label>
                  <textarea id={jobId} required rows={2} maxLength={500} value={job} onChange={(e) => setJob(e.target.value)} />
                </div>
              )}
              <details className="advanced">
                <summary>Advanced</summary>
                <div className="field">
                  <label htmlFor={modelId}>Model profile</label>
                  <input id={modelId} maxLength={128} value={modelProfile} onChange={(e) => setModelProfile(e.target.value)} />
                </div>
              </details>
            </section>
            {isCustom ? (
              <section className="panel">
                <CustomAgentFields value={custom} onChange={setCustom} />
              </section>
            ) : null}

            <section className="panel">
              <h2 className="panel-title">Spending limits</h2>
              <PolicyForm key={`${role}-${seed}`} initial={base} workspace={workspace} onChange={setPolicy} />
              <details className="advanced">
                <summary>Describe limits in words</summary>
                <div className="field">
                <label htmlFor={wordsId} className="sr-only">Describe limits in words</label>
                <div className="inline-input">
                  <input id={wordsId} value={words} onChange={(e) => setWords(e.target.value)} placeholder="Up to 2 USDC total, 0.5 per purchase, 1 per task" />
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
                    Fill in
                  </button>
                </div>
                {drafted ? (
                  <p role="status" className="hint">
                    {drafted.understood.length > 0 ? `Filled: ${drafted.understood.join("; ")}.` : "Couldn't find any limits in that."}
                    {drafted.ignored.length > 0 ? ` Skipped: ${drafted.ignored.join("; ")}.` : ""} Check the fields below.
                  </p>
                ) : null}
                </div>
              </details>
            </section>
            <CreateConnectorsStep picked={connectors} onChange={setConnectors} />
          </>
        ) : effective ? (
          <section className="panel">
            <h2 className="panel-title">Review</h2>
            <PolicyReviewGroups policy={effective} workspacePolicy={wsPolicy} title={name} hiring={isCustom ? { allowed: custom.hiring, grants: custom.grants.length } : null} />
            <CreateConnectorsStep picked={connectors} onChange={setConnectors} readOnly />
            <p className="small muted">Starts switched off — turn it on on the next screen. Connectors can be added later.</p>
          </section>
        ) : null}
        <div className="form-footer">
          {missing ? <span className="small muted">{missing}</span> : <span />}
          <span className="actions">
            {step === "review" ? (
              <button type="button" className="btn" onClick={() => {
                if (policy) setBase(policy);
                setStep("edit");
              }}>
                Back
              </button>
            ) : null}
            <button type="submit" className="btn btn-primary" disabled={missing !== null || action.busy}>
              {action.busy ? <Spinner /> : null}
              {step === "edit" ? "Review" : "Create agent"}
            </button>
          </span>
        </div>
        <ErrorNotice error={action.error} />
      </form>
    </>
  );
}
