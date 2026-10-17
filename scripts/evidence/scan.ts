// Secret scanner for evidence bundles: fails if any known secret value (keypair bytes, service
// credentials, provider key) or a secret-shaped pattern appears in the scanned files.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getBase58Decoder } from "@solana/kit";

export interface SecretValue {
  name: string;
  value: string;
}

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "OpenRouter-style API key", re: /sk-or-[A-Za-z0-9_-]{16,}/ },
  { name: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "64-byte keypair JSON array", re: /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/ },
  { name: "owner service secret file", re: /veilo-owner-service-secret-v\d:/ },
  { name: "bearer token header", re: /[Bb]earer\s+[A-Za-z0-9_\-.]{24,}/ },
];

/** Values derived from a Solana keypair file: base58 of the 64 bytes, seed hex and the JSON text prefix. */
export function keypairSecrets(path: string, name: string): SecretValue[] {
  if (!existsSync(path)) return [];
  const bytes = JSON.parse(readFileSync(path, "utf8")) as number[];
  if (!Array.isArray(bytes) || bytes.length !== 64) return [];
  const out = [
    { name: `${name} (base58 keypair)`, value: getBase58Decoder().decode(Uint8Array.from(bytes)) },
    { name: `${name} (seed hex)`, value: Buffer.from(bytes.slice(0, 32)).toString("hex") },
    { name: `${name} (seed base64)`, value: Buffer.from(bytes.slice(0, 32)).toString("base64") },
  ];
  bytes.fill(0);
  return out;
}

/** Trimmed contents of credential/secret files (only values of 16+ characters are meaningful). */
export function fileSecrets(paths: Array<{ path: string; name: string }>): SecretValue[] {
  const out: SecretValue[] = [];
  for (const p of paths) {
    if (!existsSync(p.path) || statSync(p.path).isDirectory()) continue;
    const text = readFileSync(p.path, "utf8");
    if (p.path.endsWith(".json")) {
      for (const m of text.matchAll(/"token"\s*:\s*"([^"]{16,})"/g)) out.push({ name: `${p.name} token`, value: m[1]! });
      continue;
    }
    const body = text.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("-----")).join("").trim();
    if (body.length >= 16) out.push({ name: p.name, value: body });
  }
  return out;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export function scanFiles(files: string[], secrets: SecretValue[]): string[] {
  const hits: string[] = [];
  const values = secrets.filter((s) => s.value.length >= 16);
  for (const f of files) {
    const data = readFileSync(f);
    const text = data.toString("utf8");
    for (const s of values) if (data.includes(Buffer.from(s.value, "utf8"))) hits.push(`${f}: contains ${s.name}`);
    for (const p of PATTERNS) if (p.re.test(text)) hits.push(`${f}: matches ${p.name}`);
  }
  return hits;
}

export const scanDir = (dir: string, secrets: SecretValue[]): string[] => scanFiles(walk(dir), secrets);
export const listFiles = walk;
