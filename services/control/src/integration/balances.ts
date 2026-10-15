import { CREDIT_PACK_UNITS, GATEWAY_CREDIT_LABEL, SPONSORED_PLANNING_LABEL } from "@veilo/contracts/gateway";
import { big, num, type Ledger } from "../context";
import { activeReserved, settledLifetime } from "../ledger/accounting";
import { balances } from "../ledger/summaries";
import { listAgents, type WorkspaceRow } from "../ledger/workspace";
import { GatewayUnreachableError, type GatewayClient } from "./gateway-client";

/** Balance reads older than this are reported stale. */
export const CREDIT_BALANCE_MAX_AGE_MS = 120_000;

/**
 * Owner balance view. Cash (test-USDC) spent counts each settled purchase once; a credit pack
 * is attributed to the agent that bought it. Prepaid consumption reduces gateway credits and
 * the consuming agent's usage allowance and is never added to cash spent. Sponsored planning
 * is operator cost, reported separately and never as a payment.
 */
export async function fullBalances(ledger: Ledger, ws: WorkspaceRow, gateway: GatewayClient | undefined): Promise<Record<string, unknown>> {
  const base = balances(ledger, ws);
  const agents = listAgents(ledger, ws.id);
  const wsScope = { kind: "workspace", id: ws.id } as const;

  const packs = ledger.db
    .prepare(
      `SELECT agent_id, count(*) AS n, ifnull(sum(price_usdc), 0) AS cash FROM purchase
       WHERE workspace_id = ? AND sku = 'inference-credit-pack' AND fulfilment_state = 'delivered' GROUP BY agent_id`,
    )
    .all(ws.id) as Array<{ agent_id: string; n: bigint; cash: bigint }>;
  const planning = ledger.db
    .prepare(`SELECT agent_id, ifnull(sum(planning_calls), 0) AS calls, count(*) AS tasks FROM task WHERE workspace_id = ? GROUP BY agent_id`)
    .all(ws.id) as Array<{ agent_id: string; calls: bigint; tasks: bigint }>;

  const cash = {
    unit: "usdc_base_units",
    spent: settledLifetime(ledger, wsScope, "usdc").toString(),
    reserved: activeReserved(ledger, wsScope, "usdc").toString(),
    byAgent: agents.map((a) => {
      const scope = { kind: "agent", id: a.id } as const;
      return { agentId: a.id, name: a.name, spent: settledLifetime(ledger, scope, "usdc").toString(), reserved: activeReserved(ledger, scope, "usdc").toString() };
    }),
    note: "Each USDC purchase is counted once. Credit-pack purchases are attributed to the buying agent; credit consumption is not a second payment.",
  };

  const usage = agents.map((a) => {
    const scope = { kind: "agent", id: a.id } as const;
    const bought = packs.find((p) => p.agent_id === a.id);
    return {
      agentId: a.id,
      name: a.name,
      consumedUnits: settledLifetime(ledger, scope, "usage_units").toString(),
      reservedUnits: activeReserved(ledger, scope, "usage_units").toString(),
      packsPurchased: bought ? num(bought.n) : 0,
      packUnitsPurchased: bought ? (big(bought.n) * CREDIT_PACK_UNITS).toString() : "0",
      packCashSpent: bought ? big(bought.cash).toString() : "0",
    };
  });

  let gatewayCredits: Record<string, unknown>;
  if (!gateway) {
    gatewayCredits = { available: false, code: "NOT_READY", message: "gateway credit balances are reported by the gateway ledger, which is not connected yet" };
  } else {
    try {
      const b = await gateway.balance();
      const age = ledger.now() - Date.parse(b.asOf);
      gatewayCredits = {
        available: true,
        label: GATEWAY_CREDIT_LABEL,
        unit: b.unit,
        accountId: b.accountId,
        purchased: b.issued,
        consumed: b.consumed,
        reserved: b.reserved,
        usable: b.usable,
        version: b.version,
        asOf: b.asOf,
        stale: age > CREDIT_BALANCE_MAX_AGE_MS,
        note: "Credits purchased; no extra on-chain charge for this call.",
      };
    } catch (error) {
      gatewayCredits = {
        available: false,
        code: "NOT_READY",
        label: GATEWAY_CREDIT_LABEL,
        message: error instanceof GatewayUnreachableError ? error.message : "gateway balance unavailable",
      };
    }
  }

  return {
    ...base,
    cash,
    gatewayCredits,
    usageByAgent: usage,
    sponsoredPlanning: {
      label: SPONSORED_PLANNING_LABEL,
      unit: "calls",
      note: "Operator-funded planning calls; not paid with test USDC or gateway credits.",
      total: planning.reduce((acc, r) => acc + num(r.calls), 0),
      byAgent: planning.map((r) => ({ agentId: r.agent_id, name: agents.find((a) => a.id === r.agent_id)?.name ?? null, calls: num(r.calls), tasks: num(r.tasks) })),
    },
  };
}
