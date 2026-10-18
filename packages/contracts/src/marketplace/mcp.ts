import { z } from "zod";
import { canonicalJson, sha256Hex } from "../gateway/digest";
import { codeExecutionToolProblem, mcpTemplateRefSchema, templatedToolProblem } from "./mcp-templates";

/**
 * A remote MCP tool exactly as the operator reviewed it. A server may change `tools/list` at any
 * time, so every call re-reads it and refuses when this digest no longer matches.
 */
export const mcpToolPinSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
    description: z.string().max(8_000),
    inputSchema: z.record(z.string(), z.unknown()),
    /** Present on a Veilo templated tool: it runs a fixed template through this pinned upstream tool. */
    template: mcpTemplateRefSchema.optional(),
  })
  .strict();
export type McpToolPin = z.infer<typeof mcpToolPinSchema>;

export function mcpToolDigest(t: McpToolPin): string {
  return sha256Hex(`veilo:mcp-tool:v1\n${canonicalJson({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.template ? { template: t.template } : {}) })}`);
}

/** Why a pinned tool may not be offered on this endpoint, or null. */
export function mcpToolPinProblem(t: McpToolPin, endpoint: string): string | null {
  return t.template ? templatedToolProblem({ name: t.name, inputSchema: t.inputSchema, template: t.template }, endpoint) : codeExecutionToolProblem(t);
}

export function mcpManifestDigest(tools: readonly McpToolPin[]): string {
  return sha256Hex(`veilo:mcp-manifest:v1\n${canonicalJson([...tools].sort((a, b) => a.name.localeCompare(b.name)).map((t) => mcpToolDigest(t)))}`);
}

/** Only remote streamable-HTTP servers: no local processes and no keys held by the server for the buyer. */
export function mcpEndpointProblem(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return "not a URL";
  }
  if (u.protocol !== "https:") return "must use https";
  if (u.username || u.password || u.search || u.hash) return "must not carry credentials, a query or a fragment";
  const host = u.hostname.toLowerCase();
  if (host.endsWith(".")) return "must not end with a dot";
  if (host === "localhost" || /\.(local|internal|localhost)$/.test(host) || /^[0-9.]+$/.test(host) || host.startsWith("[") || !host.includes(".")) {
    return "must be a public DNS name";
  }
  return null;
}

export const connectorProposalSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
    title: z.string().trim().min(3).max(80),
    endpoint: z.string().max(300).superRefine((v, ctx) => {
      const p = mcpEndpointProblem(v);
      if (p) ctx.addIssue({ code: "custom", message: `endpoint ${p}` });
    }),
    tools: z.array(mcpToolPinSchema).min(1).max(32),
  })
  .strict()
  .refine((c) => new Set(c.tools.map((t) => t.name)).size === c.tools.length, "tool names must be unique")
  .superRefine((c, ctx) => {
    for (const t of c.tools) {
      const p = mcpToolPinProblem(t, c.endpoint);
      if (p) ctx.addIssue({ code: "custom", message: p });
    }
  });
export type ConnectorProposal = z.infer<typeof connectorProposalSchema>;

const PLACEHOLDER = "{{input}}";

/**
 * The arguments a step sends: a JSON object whose values are fixed, except strings that are
 * exactly "{{input}}", which become the step's text input as a string value. Input text can
 * therefore never add arguments or change their structure.
 */
export function argsTemplateProblem(template: unknown, inputSchema: Record<string, unknown>): string | null {
  if (typeof template !== "object" || template === null || Array.isArray(template)) return "arguments must be a JSON object";
  if (Buffer.byteLength(JSON.stringify(template)) > 4_096) return "arguments are too large";
  const props = (inputSchema.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(inputSchema.required) ? (inputSchema.required as unknown[]) : [];
  for (const k of Object.keys(template)) if (!(k in props)) return `argument ${k} is not in the tool's input schema`;
  for (const r of required) if (typeof r === "string" && !(r in template)) return `required argument ${r} is missing`;
  let placeholders = 0;
  let bad = false;
  JSON.stringify(template, (_k, v: unknown) => {
    if (typeof v === "string" && v.includes("{{")) {
      if (v === PLACEHOLDER) placeholders += 1;
      else bad = true;
    }
    return v;
  });
  if (bad) return "a placeholder must be exactly {{input}}";
  if (placeholders === 0) return "the arguments must use {{input}} once or more";
  return null;
}

export function renderArgs(template: Record<string, unknown>, input: string): Record<string, unknown> {
  const fill = (v: unknown): unknown => {
    if (v === PLACEHOLDER) return input;
    if (Array.isArray(v)) return v.map(fill);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return fill(template) as Record<string, unknown>;
}
