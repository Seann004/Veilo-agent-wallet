"use client";

import { useParams } from "next/navigation";
import { WorkflowDetail } from "../../../../components/market/WorkflowDetail";

export default function WorkflowPage() {
  const { slug } = useParams<{ slug: string }>();
  return <WorkflowDetail key={slug} slug={slug} />;
}
