import type { AgentRole } from "./types";

export const ROLE_ORDER: AgentRole[] = ["research", "content", "credit_manager"];

export const ROLE_TAGLINE: Record<AgentRole, string> = {
  credit_manager: "Keeps inference credits topped up, one pack at a time.",
  research: "Answers questions with paid, cited sources.",
  content: "Drafts posts and a seven-day calendar.",
  custom: "Follows your instructions and finds a marketplace specialist for each job.",
};
