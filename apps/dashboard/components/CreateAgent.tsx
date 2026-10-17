"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { api } from "../lib/api";
import { ROLE_AVATAR, avatarById, setAgentAvatar } from "../lib/avatars";
import { resolveAvatar } from "../lib/avatar-customization";
import { ROLE_LABEL } from "../lib/labels";
import { ROLE_TAGLINE } from "../lib/roles";
import type { Agent, AgentRole } from "../lib/types";
import { draftPolicyFromText, type PolicyDraftResult } from "../lib/policy-draft";
import { PolicyForm, PolicyReview, ROLE_TEMPLATES, type AgentPolicyInput } from "./Policy";
import { AvatarImage, AvatarPicker } from "./Avatar";
import { useOwner } from "./Shell";
import { useAction } from "./hooks";
import { ErrorNotice, Spinner } from "./ui";

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
  const [avatarId, setAvatarId] = useState(ROLE_AVATAR.research);
  const [avatarChosen, setAvatarChosen] = useState(false);
  const [step, setStep] = useState<"edit" | "review">("edit");
  const action = useAction();
  const nameId = useId();
  const jobId = useId();
  const modelId = useId();
  const pollId = useId();
  const wsPolicy = workspace.policies.find((p) => p.scope === "workspace" && p.status === "active");
  const chooseRole = (r: AgentRole) => {
    setRole(r);
    setJob(ROLE_TEMPLATES[r].description);
    setPolicy(ROLE_TEMPLATES[r].policy);
    setBase(ROLE_TEMPLATES[r].policy);
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
          <Link className="btn" href={`/agents/${created.id}`}>
            Open {created.name}
          </Link>
        </div>
        <ErrorNotice error={action.error} />
      </section>
    );
  }

  const missing = name.trim() === "" ? "Add a name to continue." : job.trim() === "" ? "Describe the job to continue." : !policy ? "Fix the highlighted limits to continue." : null;

  return (
    <>
      <div className="page-head">
        <h1>Create agent</h1>
      </div>
      <section className="panel" aria-label="Role and avatar">
        <div className="avatar-hero">
          {preview ? <AvatarImage avatar={preview} size={96} /> : null}
          <AvatarPicker
            value={avatarId}
            onChange={(id) => {
              setAvatarId(id);
              setAvatarChosen(true);
            }}
          />
        </div>
        <h2 className="section-title">Role</h2>
        <div className="suggestions">
          {(Object.keys(ROLE_LABEL) as AgentRole[]).map((r) => {
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
          void action.run(async () => {
            const r = await api<{ agent: Agent }>("control", "/agents", {
              method: "POST",
              body: { name, role, description: job, trigger, modelProfile, policy },
            });
            setAgentAvatar(r.agent.id, avatarId);
            await reloadWorkspace();
            setCreated(r.agent);
          });
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
                  <p className="small muted field-note">Starts work when you send it a task{role === "content" ? " or approve research for it" : ""}.</p>
                )}
              </div>
              <div className="field">
                <label htmlFor={jobId}>Job</label>
                <textarea id={jobId} required rows={2} maxLength={500} value={job} onChange={(e) => setJob(e.target.value)} />
              </div>
              <details className="advanced">
                <summary>Advanced</summary>
                <div className="field">
                  <label htmlFor={modelId}>Model profile</label>
                  <input id={modelId} maxLength={128} value={modelProfile} onChange={(e) => setModelProfile(e.target.value)} />
                </div>
              </details>
            </section>

            <section className="panel">
              <h2 className="panel-title">Spending limits</h2>
              <div className="field">
                <label htmlFor={wordsId}>Describe them in your own words (optional)</label>
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
              <PolicyForm key={`${role}-${seed}`} initial={base} workspace={workspace} onChange={setPolicy} />
            </section>
          </>
        ) : policy ? (
          <section className="panel">
            <h2 className="panel-title">Review</h2>
            <PolicyReview policy={policy} workspacePolicy={wsPolicy} title={name} />
            <p className="small muted">The agent starts switched off. You can activate it on the next screen.</p>
          </section>
        ) : null}
        <div className="form-footer">
          {missing ? <span className="small muted">{missing}</span> : <span />}
          <span className="actions">
            {step === "review" ? (
              <button type="button" className="btn" onClick={() => setStep("edit")}>
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
