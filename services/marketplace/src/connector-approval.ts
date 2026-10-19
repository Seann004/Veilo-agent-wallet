import { McpClient } from "@veilo/mcp-client";
import { MarketError } from "./errors";
import { mcpTemplateServerFor, mcpToolDigest, templateServerProposalProblems, templateServerTools, type ConnectorProposal, type McpTemplateServer, type McpToolPin } from "@veilo/contracts/marketplace";

/** What the operator command reads and writes; the command itself holds no credentials. */
export interface ConnectorApprovalIo {
  /** The server's tools/list, read now. */
  liveTools: (endpoint: string) => Promise<McpToolPin[]>;
  /** The approved connector with this id, from the public catalogue. */
  approved: (id: string) => Promise<{ endpoint: string; tools: McpToolPin[] } | null>;
  /** The pending proposal with this id, from the operator review queue. */
  pending: (id: string) => Promise<{ endpoint: string; tools: McpToolPin[] } | null>;
  propose: (proposal: ConnectorProposal) => Promise<void>;
  approve: (id: string, note: string) => Promise<void>;
}

export type ConnectorPlan =
  | { action: "none"; reason: string }
  | { action: "approve-pending"; tools: Array<{ name: string; sha256: string }> }
  | { action: "propose-and-approve"; proposal: ConnectorProposal }
  | { action: "refuse"; problems: string[] };

export function planTemplateConnector(
  server: McpTemplateServer,
  s: { live: McpToolPin[]; approved: { endpoint: string; tools: McpToolPin[] } | null; pending: { endpoint: string; tools: McpToolPin[] } | null },
): ConnectorPlan {
  const expected = templateServerTools(server, s.live);
  if (expected.missing.length > 0) return { action: "refuse", problems: expected.missing.map((m) => `the live server does not list ${m}`) };
  if (s.approved) {
    const problems = templateServerProposalProblems(server, s.approved, s.live);
    if (problems.length === 0) return { action: "none", reason: `${server.id} is already approved and matches the live server` };
    return { action: "refuse", problems: [...problems, `${server.id} is approved but no longer matches; connector terms are immutable, so a changed server needs a new connector id`] };
  }
  if (s.pending) {
    const problems = templateServerProposalProblems(server, s.pending, s.live);
    if (problems.length === 0) return { action: "approve-pending", tools: s.pending.tools.map((t) => ({ name: t.name, sha256: mcpToolDigest(t) })) };
    return { action: "refuse", problems: [...problems, `the pending ${server.id} proposal does not match; reject it with connector-review or review it by hand`] };
  }
  return { action: "propose-and-approve", proposal: { id: server.id, title: server.title, endpoint: server.endpoint, tools: expected.tools } };
}

export const approvalNote = (server: McpTemplateServer) => `${server.explanation} Digests verified against the live tools/list.`;

/**
 * Plans, and with `confirm` carries out, the proposal and approval of one template server's
 * connector. Approval happens only after the pending proposal is re-read and compared with a
 * fresh tools/list.
 */
export async function runTemplateConnector(server: McpTemplateServer, io: ConnectorApprovalIo, confirm: boolean): Promise<{ plan: ConnectorPlan; outcome: "dry-run" | "unchanged" | "approved" | "refused" }> {
  const [live, approved, pending] = await Promise.all([io.liveTools(server.endpoint), io.approved(server.id), io.pending(server.id)]);
  const plan = planTemplateConnector(server, { live, approved, pending });
  if (plan.action === "refuse") return { plan, outcome: "refused" };
  if (plan.action === "none") return { plan, outcome: "unchanged" };
  if (!confirm) return { plan, outcome: "dry-run" };
  if (plan.action === "propose-and-approve") await io.propose(plan.proposal);
  const [recheck, proposed] = await Promise.all([io.liveTools(server.endpoint), io.pending(server.id)]);
  if (!proposed) throw new Error(`${server.id} is not pending review after the proposal`);
  const problems = templateServerProposalProblems(server, proposed, recheck);
  if (problems.length > 0) return { plan: { action: "refuse", problems: [...problems, "tools changed during review; not approved"] }, outcome: "refused" };
  await io.approve(server.id, approvalNote(server));
  return { plan, outcome: "approved" };
}


/** Only a registered server's canonical endpoint may be contacted during proposal discovery. */
export async function previewTemplateConnector(endpoint: string, readTools?: (endpoint: string) => Promise<McpToolPin[]>) {
  const server = mcpTemplateServerFor(endpoint);
  if (!server) throw new MarketError("SERVICE_NOT_ALLOWED", "Veilo has no fixed queries for this server");
  let live: McpToolPin[];
  try {
    if (readTools) live = await readTools(server.endpoint);
    else {
      const client = new McpClient(server.endpoint, { publicOnly: true, timeoutMs: 20_000, maxBytes: 4_000_000 });
      await client.initialize();
      live = await client.listTools();
    }
  } catch {
    throw new MarketError("PROVIDER_UNAVAILABLE", "could not read the server's live tools; try again");
  }
  const result = templateServerTools(server, live);
  if (result.missing.length) throw new MarketError("PROVIDER_UNAVAILABLE", `the live server no longer lists ${result.missing.join(", ")}`);
  return { connectorId: server.id, title: server.title, endpoint: server.endpoint, explanation: server.explanation, tools: result.tools, omitted: result.omitted };
}
