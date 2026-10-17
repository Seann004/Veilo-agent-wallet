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
      <ErrorNotice error={activity.error} what="activity" onRetry={activity.reload} />
      <Section title="Payments">
        {activity.data ? <ActivityList activity={activity.data} workspace={workspace} onChanged={reload} /> : <Loading label="payments" />}
      </Section>
      <details className="panel disclosure">
        <summary>Full history{activity.data ? ` (${activity.data.events.length})` : ""}</summary>
        {activity.data ? <EventLog events={activity.data.events} /> : <Loading label="audit log" />}
      </details>
    </>
  );
}
