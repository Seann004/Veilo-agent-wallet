import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted by code point, no whitespace. Only plain JSON
 * values are accepted so two parties always hash identical bytes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError("canonicalJson: only plain objects are allowed");
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Request digest that binds a quote or usage permit to one exact SKU input. Control and
 * gateway both compute it from the same canonical bytes.
 */
export function computeRequestDigest(sku: string, input: unknown): string {
  return sha256Hex(`veilo:request-digest:v1\n${canonicalJson({ input, sku })}`);
}

export const REQUEST_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
