"use client";

import Link from "next/link";
import { useEffect } from "react";
import { shortKey, when } from "../../lib/format";
import { presentJob } from "../../lib/market/job-state";
import type { JobRow } from "../../lib/market/types";
import { useResource } from "../hooks";
import { EmptyState, ErrorNotice, Loading } from "../ui";
import { useMarket } from "./MarketContext";
import { JobStates, RequireMarketSession, TestTokenNote } from "./parts";

export const POLL_MS = 5_000;

/** Jobs where the signed-in account is the buyer or the assigned seller (RLS decides). */
export function JobBoard() {
  return (
    <>
      <h1>Jobs</h1>
      <TestTokenNote />
      <RequireMarketSession what="see your jobs">
        <JobList />
      </RequireMarketSession>
    </>
  );
}

function JobList() {
  const m = useMarket();
  const jobs = useResource(() => m.call<{ jobs: JobRow[] }>("/jobs"), `jobs:${m.me?.userId ?? ""}`);
  const live = (jobs.data?.jobs ?? []).some((j) => presentJob(j).live);
  const { reload } = jobs;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(t);
  }, [live, reload]);

  if (jobs.loading && !jobs.data) return <Loading label="jobs" />;
  if (!jobs.data) return <ErrorNotice error={jobs.error} what="jobs could not be loaded" onRetry={jobs.reload} />;
  const workspaceId = m.me?.workspace?.id;
  return (
    <>
      <ErrorNotice error={jobs.error} what="refresh failed; showing the last loaded jobs" onRetry={jobs.reload} />
      {jobs.data.jobs.length === 0 ? (
        <EmptyState action={<Link href="/marketplace">Browse the catalogue</Link>}>No jobs yet.</EmptyState>
      ) : (
        <ul className="activity job-list">
          {jobs.data.jobs.map((j) => {
            const p = presentJob(j);
            const role = j.buyer_workspace_id && j.buyer_workspace_id === workspaceId ? "You hired" : j.seller_id && j.seller_id === m.me?.seller?.id ? "Assigned to you" : "Job";
            return (
              <li key={j.id} className="job-row">
                <div className="job-row-head">
                  <Link href={`/marketplace/jobs/${j.id}`} className="activity-label">
                    {role} · job {shortKey(j.id, 4)}
                  </Link>
                  <span className="small muted">updated {when(j.updated_at)}</span>
                </div>
                <JobStates p={p} />
                {p.notes.map((n) => (
                  <p key={n} className="small notice notice-warn">
                    {n}
                  </p>
                ))}
              </li>
            );
          })}
        </ul>
      )}
      {live ? (
        <p className="small muted" role="status">
          Refreshing every {POLL_MS / 1000} seconds while jobs are in progress.
        </p>
      ) : null}
    </>
  );
}
