// pnpm test:integration — runs the integration and fault-injection suite (tests/integration)
// against a fresh local stack and records a sanitized outcome summary with acceptance test IDs,
// environment and failed/skipped tests in artifacts/evidence/integration-<date>.json.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO, writeJson } from "./devnet/lib";
import { fileSecrets, keypairSecrets, scanFiles } from "./evidence/scan";

const OUT_DIR = join(REPO, "work", "integration-results");
const RESULTS = join(OUT_DIR, "vitest-results.json");

const PRD_IDS: Array<[RegExp, string[]]> = [
  [/IDEM-01/, ["IDEM-01", "X402-01 (local, FIXTURE inference)"]],
  [/X402-04/, ["X402-04"]],
  [/X402-03/, ["X402-03"]],
  [/REC-01 \/ REC-02/, ["REC-01"]],
  [/REC-02\)/, ["REC-02"]],
  [/CRE-01/, ["CRE-01"]],
  [/CRE-03/, ["CRE-03"]],
  [/USG-01/, ["USG-01"]],
  [/LLM-01/, ["LLM-01"]],
  [/QUO-01/, ["QUO-01"]],
  [/QUO-02/, ["QUO-02"]],
  [/LED-01/, ["LED-01"]],
  [/CAP-02/, ["CAP-02"]],
  [/BAK-01/, ["BAK-01"]],
  [/REC-03/, ["REC-03", "LED-01 (external recovery)"]],
  [/REV-01/, ["REV-01"]],
  [/SEC-02/, ["SEC-02"]],
];

function preflight(): string[] {
  const problems: string[] = [];
  if (spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" }).status !== 0) problems.push("Docker daemon is not reachable");
  if (!existsSync(join(REPO, "target", "deploy", "privacy_pool.so"))) problems.push("target/deploy/privacy_pool.so missing (pnpm tc -- anchor build --ignore-keys)");
  for (const c of ["spend", "insert", "exit"]) if (!existsSync(join(REPO, "circuits", "build", "zkey", `${c}_final.zkey`))) problems.push(`circuits/build ${c} proving key missing (pnpm test:circuits)`);
  return problems;
}

interface AssertionResult {
  ancestorTitles: string[];
  title: string;
  status: string;
  duration?: number;
  failureMessages?: string[];
}

function main(): number {
  const problems = preflight();
  if (problems.length > 0) {
    console.error(`test:integration cannot start:\n  - ${problems.join("\n  - ")}`);
    return 2;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const started = new Date();
  const r = spawnSync(process.execPath, [join(REPO, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "tests/integration/vitest.config.ts", "--reporter=default", "--reporter=json", `--outputFile.json=${RESULTS}`, ...process.argv.slice(2)], { cwd: REPO, stdio: "inherit", env: process.env });
  if (!existsSync(RESULTS)) {
    console.error("no vitest results were written");
    return r.status ?? 1;
  }
  const res = JSON.parse(readFileSync(RESULTS, "utf8")) as { numTotalTests: number; numPassedTests: number; numFailedTests: number; numPendingTests: number; numTodoTests: number; testResults: Array<{ assertionResults: AssertionResult[]; message?: string }> };
  const tests = res.testResults.flatMap((f) => f.assertionResults).map((a) => {
    const full = [...a.ancestorTitles, a.title].join(" › ");
    const ids = [...new Set(PRD_IDS.filter(([re]) => re.test(full)).flatMap(([, v]) => v))];
    return { test: full, status: a.status, durationMs: Math.round(a.duration ?? 0), prdIds: ids, ...(a.failureMessages?.length ? { failure: a.failureMessages.join("\n").slice(0, 2_000) } : {}) };
  });
  const scenarioPath = join(REPO, "work", "integration", "scenario-evidence.json");
  const scenario = existsSync(scenarioPath) ? (JSON.parse(readFileSync(scenarioPath, "utf8")) as Record<string, unknown>) : {};
  const out = join(REPO, "artifacts", "evidence", `integration-${started.toISOString().replace(/[:.]/g, "-")}.json`);
  const byId: Record<string, string[]> = {};
  for (const t of tests) for (const id of t.prdIds) (byId[id] ??= []).push(t.status);
  writeJson(out, {
    kind: "Veilo integration and fault-injection suite (pnpm test:integration)",
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    environment: {
      ...(scenario.environment as Record<string, unknown> | undefined),
      host: `${process.platform} ${process.arch}, Node ${process.version}`,
      services: "control, runner, wallet, relayer, gateway as separate processes (services/*/src/index.ts) behind loopback fault proxies",
      label: "LOCAL TEST VALIDATOR evidence: no devnet transaction; inference is FIXTURE (mock provider), not real inference",
    },
    counts: { total: res.numTotalTests, passed: res.numPassedTests, failed: res.numFailedTests, skipped: res.numPendingTests + res.numTodoTests },
    prdCoverage: Object.fromEntries(Object.entries(byId).map(([id, st]) => [id, st.every((s) => s === "passed") ? "passed" : st.join(",")])),
    tests,
    failedOrSkipped: tests.filter((t) => t.status !== "passed").map((t) => ({ test: t.test, status: t.status })),
    scenarioEvidence: Object.fromEntries(Object.entries(scenario).filter(([k]) => k !== "environment")),
  });
  const keysDir = join(REPO, "work", "integration", "keys");
  const secrets = [
    ...(existsSync(keysDir) ? readdirSync(keysDir).flatMap((f) => keypairSecrets(join(keysDir, f), f)) : []),
    ...fileSecrets(["control-service.credential", "wallet-service.credential", "owner-service.secret", "control/gateway-account.token", "gateway/planning.token"].map((f) => ({ path: join(REPO, "work", "integration", "secrets", f), name: f }))),
  ];
  const hits = scanFiles([out], secrets);
  if (hits.length > 0) {
    console.error(`integration evidence secret scan failed:\n  ${hits.join("\n  ")}`);
    return 1;
  }
  console.log(`\nintegration summary: ${res.numPassedTests}/${res.numTotalTests} passed, ${res.numFailedTests} failed, ${res.numPendingTests + res.numTodoTests} skipped → ${relative(REPO, out)}`);
  return r.status ?? 1;
}

process.exit(main());
