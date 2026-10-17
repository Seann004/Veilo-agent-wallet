"use client";

import { useParams } from "next/navigation";
import { JobDetail } from "../../../../components/market/JobDetail";

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  return <JobDetail key={id} jobId={id} />;
}
