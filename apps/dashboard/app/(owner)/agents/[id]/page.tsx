"use client";

import { useParams } from "next/navigation";
import { AgentDetail } from "../../../../components/AgentDetail";

export default function AgentPage() {
  const { id } = useParams<{ id: string }>();
  return <AgentDetail key={id} agentId={id} />;
}
