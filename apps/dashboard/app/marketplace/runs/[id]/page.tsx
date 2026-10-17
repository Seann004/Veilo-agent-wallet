"use client";

import { useParams } from "next/navigation";
import { WorkflowRunView } from "../../../../components/market/WorkflowRuns";

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  return <WorkflowRunView key={id} runId={id} />;
}
