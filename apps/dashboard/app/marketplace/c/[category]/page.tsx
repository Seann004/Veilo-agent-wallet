"use client";

import { useParams } from "next/navigation";
import { WorkflowBrowse } from "../../../../components/market/WorkflowBrowse";

export default function CategoryPage() {
  const { category } = useParams<{ category: string }>();
  return <WorkflowBrowse key={category} category={category} />;
}
