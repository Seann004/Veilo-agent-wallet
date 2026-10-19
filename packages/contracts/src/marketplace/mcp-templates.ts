import { z } from "zod";
import { canonicalJson, sha256Hex } from "../gateway/digest";

/**
 * Veilo-defined tools that run a fixed code template through an upstream code-execution tool
 * (such as CoinGecko's `execute`). The agent supplies only narrow, schema-checked values; the code
 * sent upstream is this file's template with those values inserted as JSON literals.
 */
export interface McpTemplate {
  name: string;
  /** Endpoint host the template is written for; any other host is refused. */
  host: string;
  /** The upstream tool that runs the code. Its digest is pinned at approval. */
  upstream: string;
  /** How a citation names the data source. */
  source: string;
  description: string;
  /** JSON Schema shown to the planner and approved by the operator; `args` enforces it. */
  inputSchema: Record<string, unknown>;
  args: z.ZodType<Record<string, unknown>>;
  /** Code sent upstream. `__PARAMS__`, when present, becomes JSON.stringify(params(args)). */
  code: string;
  params: (args: Record<string, unknown>) => Record<string, unknown>;
}

const PARAMS = "__PARAMS__";
const COINGECKO = { host: "mcp.api.coingecko.com", upstream: "execute", source: "CoinGecko (mcp.api.coingecko.com)" } as const;
const VS_CURRENCIES = ["usd", "eur", "gbp", "jpy", "sgd", "btc", "eth", "sol"] as const;
const COIN_ID = "^[a-z0-9-]{1,64}$";
const SEARCH_QUERY = "^[A-Za-z0-9 .-]{1,40}$";

const simplePriceArgs = z
  .object({
    ids: z.array(z.string().regex(new RegExp(COIN_ID))).min(1).max(10),
    vs_currencies: z.array(z.enum(VS_CURRENCIES)).min(1).max(5).optional(),
  })
  .strict();

export const MCP_TEMPLATES: readonly McpTemplate[] = [
  {
    ...COINGECKO,
    name: "coingecko_simple_price",
    description:
      "Live price and 24-hour change for 1 to 10 coins from CoinGecko's public API. ids are CoinGecko coin ids such as bitcoin, ethereum or solana (use coingecko_search to find an id). vs_currencies defaults to usd.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string", pattern: COIN_ID }, minItems: 1, maxItems: 10 },
        vs_currencies: { type: "array", items: { type: "string", enum: [...VS_CURRENCIES] }, minItems: 1, maxItems: 5 },
      },
      required: ["ids"],
      additionalProperties: false,
    },
    args: simplePriceArgs,
    code: `async function run(client) { return await client.simple.price.get(${PARAMS}); }`,
    params: (a) => {
      const v = simplePriceArgs.parse(a);
      return { ids: [...new Set(v.ids)].join(","), vs_currencies: [...new Set(v.vs_currencies ?? ["usd"])].join(","), include_24hr_change: true };
    },
  },
  {
    ...COINGECKO,
    name: "coingecko_trending",
    description: "Coins trending on CoinGecko in the last 24 hours: name, symbol and market-cap rank of up to 15 coins. Takes no input.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    args: z.object({}).strict(),
    code: "async function run(client) { const r = await client.search.trending.get(); return (r.coins ?? []).slice(0, 15).map((c) => ({ name: c.item.name, symbol: c.item.symbol, rank: c.item.market_cap_rank })); }",
    params: () => ({}),
  },
  {
    ...COINGECKO,
    name: "coingecko_search",
    description: "Find CoinGecko coin ids by name or symbol, for example to turn \"bitcoin\" or \"SOL\" into an id for coingecko_simple_price. Returns the top 5 matches with id, name and symbol.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", pattern: SEARCH_QUERY, minLength: 1, maxLength: 40 } },
      required: ["query"],
      additionalProperties: false,
    },
    args: z.object({ query: z.string().regex(new RegExp(SEARCH_QUERY)) }).strict(),
    code: `async function run(client) { const r = await client.search.get(${PARAMS}); return (r.coins ?? []).slice(0, 5).map((c) => ({ id: c.id, name: c.name, symbol: c.symbol })); }`,
    params: (a) => ({ query: String(a.query) }),
  },
];

export function mcpTemplate(name: string): McpTemplate | undefined {
  return MCP_TEMPLATES.find((t) => t.name === name);
}

/** Binds an approval to the exact template code, host and upstream tool. */
export function mcpTemplateCodeDigest(t: Pick<McpTemplate, "name" | "host" | "upstream" | "code">): string {
  return sha256Hex(`veilo:mcp-template:v1\n${canonicalJson({ name: t.name, host: t.host, upstream: t.upstream, code: t.code })}`);
}

/** What an approved templated tool records: the template code digest and the upstream tool's digest. */
export const mcpTemplateRefSchema = z
  .object({
    upstream: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
    upstreamSha256: z.string().regex(/^[0-9a-f]{64}$/),
    codeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type McpTemplateRef = z.infer<typeof mcpTemplateRefSchema>;

/** The pin a proposal carries for a templated tool, given the live upstream tool's digest. */
export function templatedToolPin(name: string, upstreamSha256: string) {
  const t = mcpTemplate(name);
  if (!t) throw new Error(`unknown MCP template ${name}`);
  return { name: t.name, description: t.description, inputSchema: t.inputSchema, template: { upstream: t.upstream, upstreamSha256, codeSha256: mcpTemplateCodeDigest(t) } };
}

/**
 * Refuses a templated pin unless it matches a template in this build exactly: same name,
 * description, schema, upstream tool, code digest and endpoint host. A changed template therefore
 * needs a new approval.
 */
export function templatedToolProblem(pin: { name: string; description: string; inputSchema: Record<string, unknown>; template: McpTemplateRef }, endpoint: string): string | null {
  const t = mcpTemplate(pin.name);
  if (!t) return `tool ${pin.name} is not a known Veilo template`;
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return "connector endpoint is not a URL";
  }
  if (host !== t.host) return `template ${t.name} only runs on ${t.host}`;
  if (pin.template.upstream !== t.upstream) return `template ${t.name} runs only through ${t.upstream}`;
  if (pin.template.codeSha256 !== mcpTemplateCodeDigest(t)) return `template ${t.name} code changed since it was approved`;
  if (canonicalJson(pin.inputSchema) !== canonicalJson(t.inputSchema)) return `template ${t.name} input schema differs from the approved one`;
  if (pin.description !== t.description) return `template ${t.name} description differs from the approved one`;
  return null;
}

/**
 * Tools that run caller-supplied code are never callable directly: the model could write any
 * program. They are reachable only through a template.
 */
export function codeExecutionToolProblem(pin: { name: string; inputSchema: Record<string, unknown> }): string | null {
  const props = typeof pin.inputSchema.properties === "object" && pin.inputSchema.properties !== null ? (pin.inputSchema.properties as Record<string, unknown>) : {};
  if (["execute", "run_code", "eval"].includes(pin.name.toLowerCase()) || Object.hasOwn(props, "code") || Object.hasOwn(props, "script")) {
    return `tool ${pin.name} runs caller-supplied code and can only be used through a Veilo template`;
  }
  return null;
}

/**
 * Validates the agent's arguments against the template and returns the upstream call. Values reach
 * the code only as JSON literals of schema-checked data.
 */
export function renderTemplatedCall(name: string, args: unknown): { ok: true; upstream: string; args: { code: string } } | { ok: false; problem: string } {
  const t = mcpTemplate(name);
  if (!t) return { ok: false, problem: `tool ${name} is not a known Veilo template` };
  const parsed = t.args.safeParse(args);
  if (!parsed.success) return { ok: false, problem: `arguments do not match the ${name} input schema` };
  const code = t.code.includes(PARAMS) ? t.code.replace(PARAMS, () => JSON.stringify(t.params(parsed.data))) : t.code;
  return { ok: true, upstream: t.upstream, args: { code } };
}
