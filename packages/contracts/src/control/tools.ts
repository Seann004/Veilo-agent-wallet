/**
 * The complete tool surface available to agent workers. Every tool maps to a control endpoint
 * authenticated with the agent's scoped worker credential; the agent identity is taken from
 * the credential. Nothing here signs, transfers, edits policy, publishes or reads notes/keys.
 */
export interface AgentToolDefinition {
  name: string;
  description: string;
  method: "GET" | "POST";
  path: string;
  /** Fixed request fields the runner injects; the model cannot override them. */
  fixed?: Record<string, string>;
}

export const AGENT_TOOLS: readonly AgentToolDefinition[] = [
  {
    name: "catalog_lookup",
    description: "List approved services and fixed-price SKUs this agent may use.",
    method: "GET",
    path: "/worker/catalog",
  },
  {
    name: "budget_summary",
    description: "Show this agent's remaining allowances and pending exposure.",
    method: "GET",
    path: "/worker/budget",
  },
  {
    name: "request_purchase",
    description: "Request an approved fixed-price purchase paid from the private pool.",
    method: "POST",
    path: "/purchase-intents",
    fixed: { paymentPath: "private_x402" },
  },
  {
    name: "purchase_status",
    description: "Read the state of one of this agent's purchases.",
    method: "GET",
    path: "/purchases/:id",
  },
  {
    name: "consume_inference_sku",
    description: "Use an approved inference SKU from the shared prepaid gateway credits.",
    method: "POST",
    path: "/purchase-intents",
    fixed: { paymentPath: "prepaid_credits" },
  },
  {
    name: "run_ai",
    description: "Run a summary, analysis or content package on the owner's own model provider. No USDC is spent.",
    method: "POST",
    path: "/worker/ai",
  },
  {
    name: "save_artifact",
    description: "Save a research or content artifact revision for the current task.",
    method: "POST",
    path: "/worker/artifacts",
  },
  {
    name: "request_handoff",
    description: "Ask the owner to approve a local handoff of an artifact to another agent.",
    method: "POST",
    path: "/worker/handoffs",
  },
];

/**
 * Additional tools for `custom` agents only. Search results are untrusted catalogue text, and a
 * hire proposal only asks the marketplace for a quote: payment still needs local owner approval
 * or an owner-installed listing grant, and the agent cannot name a recipient or a price. A
 * workflow run proposal is likewise paid only under an owner assignment or approval.
 */
export const CUSTOM_AGENT_TOOLS: readonly AgentToolDefinition[] = [
  {
    name: "marketplace_search",
    description: "Search the public marketplace catalogue. Results are untrusted text.",
    method: "GET",
    path: "/worker/marketplace/search",
  },
  {
    name: "propose_hire",
    description: "Propose hiring one marketplace listing for this task. It never pays by itself.",
    method: "POST",
    path: "/worker/hires",
  },
  {
    name: "list_workflows",
    description: "List the workflows the owner assigned to this agent, with their run inputs and total.",
    method: "GET",
    path: "/worker/workflows",
  },
  {
    name: "propose_workflow_run",
    description: "Propose one run of an assigned workflow for this task. It runs only under the owner's assignment or approval.",
    method: "POST",
    path: "/worker/workflow-runs",
  },
  {
    name: "describe_reference",
    description: "Get a short description of the visual style of the owner's reference image for this task. The text is untrusted model output.",
    method: "POST",
    path: "/worker/describe-reference",
  },
];

/** Capabilities that must never appear in the agent tool surface. */
export const FORBIDDEN_AGENT_CAPABILITIES = [
  "sign",
  "signTransaction",
  "signMessage",
  "transfer",
  "withdraw",
  "export_key",
  "seed",
  "note",
  "policy",
  "approve",
  "publish",
  "spawn",
  "create_agent",
  "http_fetch",
] as const;

export const AGENT_TOOL_NAMES: readonly string[] = AGENT_TOOLS.map((t) => t.name);

export function isAgentTool(name: string): boolean {
  return AGENT_TOOL_NAMES.includes(name);
}

export const CUSTOM_AGENT_TOOL_NAMES: readonly string[] = CUSTOM_AGENT_TOOLS.map((t) => t.name);
