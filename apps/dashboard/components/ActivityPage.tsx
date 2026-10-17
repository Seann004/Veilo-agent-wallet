"use client";

import { api } from "../lib/api";
import type { Activity } from "../lib/types";
import { ActivityList, EventLog } from "./Activity";
import { useOwner } from "./Shell";
import { useResource } from "./hooks";
import { ErrorNotice, Loading, Section } from "./ui";

export function ActivityPage() {
  const { workspace, reloadWorkspace } = useOwner();
  const activity = useResource(() => api<Activity>("control", "/activity?limit=100"), "activity");
  const reload = async () => {
    await Promise.all([reloadWorkspace(), activity.reload()]);
  };
  return (
    <>
      <h1>Activity</h1>
      <ErrorNotice error={activity.error} what="activity" />
      <Section
        title="Payments"
        actions={
          <button type="button" className="btn" onClick={() => void reload()}>
            Refresh
          </button>
        }
      >
        <p className="small">Select a payment to see every leg, the policy result, fees, signatures and devnet explorer links.</p>
        {activity.data ? <ActivityList activity={activity.data} workspace={workspace} onChanged={reload} /> : <Loading label="activity" />}
      </Section>
      <Section title="Audit events">{activity.data ? <EventLog events={activity.data.events} /> : null}</Section>
    </>
  );
}
