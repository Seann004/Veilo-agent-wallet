import type { AgentRole } from "./types";

export const ROLE_ORDER: AgentRole[] = ["research", "content", "custom"];

export const ROLE_TAGLINE: Record<AgentRole, string> = {
  credit_manager: "Keeps inference credits topped up, one pack at a time.",
  research: "Answers questions with paid, cited sources.",
  content: "Drafts posts and a seven-day calendar.",
  custom: "Does the work itself with your connectors, and hires a specialist only when needed.",
};
