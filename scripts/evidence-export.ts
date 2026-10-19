// pnpm evidence:export [-- --out <dir>] — sanitized evidence bundle: deployment manifest and role
// public keys, artifact hashes, addresses, every recorded transaction signature with explorer
// links, the latest test outcome summaries and the redacted owner ledger of the latest demo run.
// The bundle is scanned for known secret values and secret-shaped patterns; any hit fails.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { findRepoRoot, loadDotEnv } from "@veilo/contracts";
import { argValue, writeJson } from "./devnet/lib";
import { evidenceSignatures, type EvidenceSignature } from "./evidence/signatures";
import { fileSecrets, keypairSecrets, listFiles, scanDir, type SecretValue } from "./evidence/scan";

const root = findRepoRoot();
const rel = (p: string) => relative(root, p).split("\\").join("/");
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const evidenceDir = join(root, "artifacts", "evidence");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = argValue("--out") ?? join(root, "artifacts", "evidence-export", stamp);

function knownSecrets(): SecretValue[] {
  loadDotEnv({ rootDir: root, allowProviderSecrets: true });
  const s: SecretValue[] = [];
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (key) s.push({ name: "OpenRouter API key", value: key });
  const keyFiles = [...listFiles(join(root, "work", "keys")), ...listFiles(join(root, "work", "integration", "keys")), ...listFiles(join(root, "work", "demo-rehearsal", "keys"))].filter((f) => f.endsWith(".json"));
  for (const f of keyFiles) s.push(...keypairSecrets(f, rel(f)));
  const secretDirs = [join(root, "secrets"), ...[join(root, "work", "demo", "devnet"), join(root, "work", "integration"), join(root, "work", "demo-rehearsal")].flatMap((d) => listFiles(d).filter((f) => /[\\/]secrets[\\/]/.test(f)))];
  const files = secretDirs.flatMap((d) => (existsSync(d) && statSync(d).isDirectory() ? listFiles(d) : [d])).filter((f) => !f.endsWith(".sqlite") && !f.endsWith(".sqlite-wal") && !f.endsWith(".sqlite-shm") && !f.endsWith(".pem.pub"));
  s.push(...fileSecrets(files.filter((f) => !/usage-permit-public\.pem$/.test(f)).map((f) => ({ path: f, name: rel(f) }))));
  return s;
}

function latest(prefix: string, isDir: boolean): string | null {
  if (!existsSync(evidenceDir)) return null;
  const c = readdirSync(evidenceDir).filter((f) => f.startsWith(prefix) && statSync(join(evidenceDir, f)).isDirectory() === isDir).sort();
  return c.length ? join(evidenceDir, c[c.length - 1]!) : null;
}

function main(): void {
  mkdirSync(out, { recursive: true });
  const copied: string[] = [];
  const copy = (src: string, name = basename(src)) => {
    if (!existsSync(src)) return;
    mkdirSync(join(out, ...name.split("/").slice(0, -1)), { recursive: true });
    copyFileSync(src, join(out, name));
    copied.push(name);
  };
  const dep = join(root, "artifacts", "deployment");
  copy(join(dep, "devnet.json"), "deployment/devnet.json");
  copy(join(dep, "roles.devnet.json"), "deployment/roles.devnet.json");
  copy(join(dep, "approved-labels.json"), "deployment/approved-labels.json");

  const hashed = [
    "pnpm-lock.yaml",
    "target/deploy/privacy_pool.so",
    "artifacts/program/privacy_pool.json",
    "artifacts/circuits/manifest.json",
    "artifacts/circuits/spend.vkey.json",
    "artifacts/circuits/insert.vkey.json",
    "artifacts/circuits/exit.vkey.json",
    "artifacts/vectors/v1.json",
    "artifacts/deployment/devnet.json",
  ]
    .filter((f) => existsSync(join(root, f)))
    .map((f) => ({ file: f, sha256: sha(join(root, f)), bytes: statSync(join(root, f)).size }));

  const manifest = existsSync(join(dep, "devnet.json")) ? (JSON.parse(readFileSync(join(dep, "devnet.json"), "utf8")) as Record<string, Record<string, unknown>>) : null;
  const roles = existsSync(join(dep, "roles.devnet.json")) ? (JSON.parse(readFileSync(join(dep, "roles.devnet.json"), "utf8")) as { roles: Record<string, { publicKey: string }> }) : null;
  const addresses = {
    program: manifest?.program?.programId ?? null,
    programData: manifest?.program?.programDataAddress ?? null,
    poolState: manifest?.pool?.poolState ?? null,
    vault: manifest?.pool?.vault ?? null,
    vaultAuthority: manifest?.pool?.vaultAuthority ?? null,
    approvalState: manifest?.pool?.approvalState ?? null,
    mint: manifest?.token?.mint ?? null,
    gateway: manifest?.gateway ?? null,
    roles: roles ? Object.fromEntries(Object.entries(roles.roles).map(([k, v]) => [k, v.publicKey])) : null,
  };

  const signatures: EvidenceSignature[] = [];
  const devnetEvidence = existsSync(evidenceDir) ? readdirSync(evidenceDir).filter((f) => f.endsWith(".json")) : [];
  for (const f of devnetEvidence) {
    copy(join(evidenceDir, f), `evidence/${f}`);
    signatures.push(...evidenceSignatures(JSON.parse(readFileSync(join(evidenceDir, f), "utf8")), f));
  }
  const demo = latest("demo-", true);
  if (demo) {
    for (const f of listFiles(demo)) {
      const name = `demo/${relative(demo, f).split("\\").join("/")}`;
      copy(f, name);
      if (f.endsWith(".json")) signatures.push(...evidenceSignatures(JSON.parse(readFileSync(f, "utf8")), name));
    }
  }
  const unique = [...new Map(signatures.map((s) => [`${s.network}:${s.signature}`, s])).values()];
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

  writeJson(join(out, "index.json"), {
    kind: "Veilo sanitized evidence bundle",
    exportedAt: new Date().toISOString(),
    exportSource: { commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain").length > 0, scope: "Exporter checkout only; does not establish the source commit tested by historical records." },
    network: "Solana devnet (test USDC, no monetary value); integration-*.json files are local test validator results",
    addresses,
    artifactHashes: hashed,
    signatures: unique,
    latestDemoRun: demo ? rel(demo) : null,
    testOutcomes: devnetEvidence.filter((f) => f.startsWith("integration-")),
    notes: [
      "Operator-funded commercial inference, demo fixture data and test-chain payments are labeled separately inside each file.",
      "Receipt network labels come from source records. Only explicit devnet evidence has devnet Explorer links; local-validator and unknown receipts have no public Explorer link. Export does not recheck finality.",
      "No keys, credentials, note secrets or provider keys are included; the bundle is scanned before it is accepted.",
    ],
    files: [...copied, "index.json"],
  });
  const files = listFiles(out);
  const hits = scanDir(out, knownSecrets());
  if (hits.length > 0) {
    console.error(`evidence:export FAILED the secret scan; remove ${rel(out)} and fix the source files:\n  ${hits.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`evidence:export: ${files.length} files, ${unique.length} signatures, ${hashed.length} artifact hashes → ${rel(out)} (secret scan clean)`);
}

main();
