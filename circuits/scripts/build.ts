// Compiles the circuits, runs the development setup and writes artifacts/circuits/manifest.json.
//
//   tsx circuits/scripts/build.ts                  build what is missing; fail if any hash differs from the manifest
//   tsx circuits/scripts/build.ts --update-manifest  accept new hashes (circuit or setup change)
//   tsx circuits/scripts/build.ts --secret-contribution --update-manifest
//        adds an OS-entropy contribution before each beacon. The result is not reproducible,
//        so the .ptau/.zkey files must then be archived alongside the manifest.
//
// The default setup is deterministic: Phase 1 and Phase 2 use only public beacons, so anyone
// can rebuild identical files from source, and anyone can also derive the toxic waste. It is a
// development setup, not a trusted ceremony.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { curves, powersOfTau, r1cs as r1csApi, zKey, type VerificationKey } from "snarkjs";
import { PUBLIC_INPUTS, vkG1, vkG2 } from "@veilo/privacy-sdk";
import {
  ARTIFACTS_DIR,
  artifactPaths,
  circomlibParent,
  circomlibVersion,
  COMPILER_FLAGS,
  HARNESS_CIRCUITS,
  MAIN_CIRCUITS,
  MANIFEST_PATH,
  outDir,
  PTAU_PATH,
  PTAU_POWER,
  readJson,
  RUST_VK_DIR,
  sha256File,
  sha256Text,
  sourceFiles,
  sourcePath,
  sourceTreeHash,
  stableJson,
  toolchain,
  toRepoPosix,
  type MainCircuit,
} from "./lib";

const args = new Set(process.argv.slice(2));
const updateManifest = args.has("--update-manifest");
const secretContribution = args.has("--secret-contribution");

const BEACON_ITERATIONS_EXP = 10;
const beaconHash = (label: string): string => sha256Text(`veilo/dev-setup/v1/${label}`);

const logger = {
  debug: () => {},
  info: () => {},
  warn: (m: string) => console.warn(m),
  error: (m: string) => console.error(m),
};

function log(msg: string): void {
  console.log(`[circuits] ${msg}`);
}

// ---- compile -------------------------------------------------------------------------------

function compile(): string {
  const lib = toRepoPosix(circomlibParent());
  const all = [...MAIN_CIRCUITS, ...HARNESS_CIRCUITS];
  const stale = all.filter((name) => {
    const p = artifactPaths(name);
    const stamp = resolve(outDir(name), "source.sha256");
    const want = sourceTreeHash(sourceFiles(sourcePath(name)));
    return !existsSync(p.r1cs) || !existsSync(p.wasm) || !existsSync(stamp) || readFileSync(stamp, "utf8") !== want;
  });
  const cmds = ["circom --version"];
  for (const name of stale) {
    const src = toRepoPosix(sourcePath(name));
    const out = toRepoPosix(outDir(name));
    cmds.push(
      `rm -rf /workspace/${out} && mkdir -p /workspace/${out}`,
      `circom /workspace/${src} ${COMPILER_FLAGS.join(" ")} -l /workspace/${lib} -o /workspace/${out} > /workspace/${out}/compile.log`,
    );
  }
  if (stale.length > 0) log(`compiling ${stale.join(", ")} in the toolchain image`);
  const version = toolchain(cmds.join(" && ")).trim().split("\n")[0]!.trim();
  for (const name of stale) {
    writeFileSync(resolve(outDir(name), "source.sha256"), sourceTreeHash(sourceFiles(sourcePath(name))));
  }
  return version;
}

// ---- Phase 1 -------------------------------------------------------------------------------

async function phase1(): Promise<string[]> {
  const contributions = [`beacon ${beaconHash("phase1")} 2^${BEACON_ITERATIONS_EXP}`];
  if (secretContribution) contributions.unshift("os-entropy contribution (discarded)");
  if (existsSync(PTAU_PATH)) {
    if (secretContribution) throw new Error("--secret-contribution needs a clean circuits/build directory");
    return contributions;
  }
  log(`generating development powers of tau (2^${PTAU_POWER}); this takes a few minutes`);
  mkdirSync(dirname(PTAU_PATH), { recursive: true });
  const tmp = (n: number) => resolve(dirname(PTAU_PATH), `tmp_${n}.ptau`);
  const curve = await curves.getCurveFromName("bn128");
  try {
    await powersOfTau.newAccumulator(curve, PTAU_POWER, tmp(0), logger);
    let last = tmp(0);
    if (secretContribution) {
      await powersOfTau.contribute(last, tmp(1), "veilo development contribution", randomBytes(64).toString("hex"), logger);
      last = tmp(1);
    }
    await powersOfTau.beacon(last, tmp(2), "veilo development beacon", beaconHash("phase1"), BEACON_ITERATIONS_EXP, logger);
    await powersOfTau.preparePhase2(tmp(2), tmp(3), logger);
    renameSync(tmp(3), PTAU_PATH);
  } finally {
    for (const n of [0, 1, 2, 3]) rmSync(tmp(n), { force: true });
    await curve.terminate();
  }
  return contributions;
}

// ---- Phase 2 and verifying keys --------------------------------------------------------------

async function phase2(name: MainCircuit): Promise<string[]> {
  const p = artifactPaths(name);
  const contributions = [`beacon ${beaconHash(`phase2/${name}`)} 2^${BEACON_ITERATIONS_EXP}`];
  if (secretContribution) contributions.unshift("os-entropy contribution (discarded)");
  if (existsSync(p.zkey)) {
    if (secretContribution) throw new Error("--secret-contribution needs a clean circuits/build directory");
    return contributions;
  }
  log(`phase 2 for ${name}`);
  mkdirSync(dirname(p.zkey), { recursive: true });
  const z0 = `${p.zkey}.0`;
  const z1 = `${p.zkey}.1`;
  const z2 = `${p.zkey}.2`;
  try {
    await zKey.newZKey(p.r1cs, PTAU_PATH, z0, logger);
    let last = z0;
    if (secretContribution) {
      await zKey.contribute(z0, z1, "veilo development contribution", randomBytes(64).toString("hex"), logger);
      last = z1;
    }
    await zKey.beacon(last, z2, "veilo development beacon", beaconHash(`phase2/${name}`), BEACON_ITERATIONS_EXP, logger);
    if (!(await zKey.verifyFromR1cs(p.r1cs, PTAU_PATH, z2, logger))) throw new Error(`zkey verification failed for ${name}`);
    renameSync(z2, p.zkey);
  } finally {
    for (const f of [z0, z1, z2]) rmSync(f, { force: true });
  }
  return contributions;
}

function rustBytes(bytes: Uint8Array, indent: string): string {
  const parts = Array.from(bytes, (b) => String(b));
  const lines: string[] = [];
  for (let i = 0; i < parts.length; i += 16) lines.push(`${indent}${parts.slice(i, i + 16).join(", ")},`);
  return lines.join("\n");
}

/** groth16-solana 0.2.0 `Groth16Verifyingkey` (field spelled `vk_gamme_g2` in that release). */
function rustVk(name: MainCircuit, vk: VerificationKey, vkJsonSha256: string): string {
  const upper = name.toUpperCase();
  const n = PUBLIC_INPUTS[name].length;
  if (vk.nPublic !== n || vk.IC.length !== n + 1) throw new Error(`${name}: verifying key has ${vk.nPublic} public inputs`);
  const g2 = (label: string, p: string[][]) => `    ${label}: [\n${rustBytes(vkG2(p), "        ")}\n    ],`;
  const ic = vk.IC.map((p) => `        [\n${rustBytes(vkG1(p), "            ")}\n        ],`).join("\n");
  return `// @generated by circuits/scripts/build.ts from artifacts/circuits/${name}.vkey.json
// (sha256 ${vkJsonSha256}). Do not edit; rebuild the circuits instead.
// Encoding: G1 = x || y, G2 = x.c1 || x.c0 || y.c1 || y.c0, 32-byte big-endian coordinates.

use groth16_solana::groth16::Groth16Verifyingkey;

/// Public inputs, in order: ${PUBLIC_INPUTS[name].join(", ")}.
pub const ${upper}_NR_INPUTS: usize = ${n};

pub const ${upper}_VK: Groth16Verifyingkey<'static> = Groth16Verifyingkey {
    nr_pubinputs: ${n},
    vk_alpha_g1: [
${rustBytes(vkG1(vk.vk_alpha_1), "        ")}
    ],
${g2("vk_beta_g2", vk.vk_beta_2)}
${g2("vk_gamme_g2", vk.vk_gamma_2)}
${g2("vk_delta_g2", vk.vk_delta_2)}
    vk_ic: &[
${ic}
    ],
};
`;
}

// ---- main ----------------------------------------------------------------------------------

const circomVersion = compile();
mkdirSync(ARTIFACTS_DIR, { recursive: true });
mkdirSync(RUST_VK_DIR, { recursive: true });
const phase1Contributions = await phase1();
const ptauSha = sha256File(PTAU_PATH);

const circuits: Record<string, unknown> = {};
const sources: Record<string, Record<string, string>> = {};
for (const name of MAIN_CIRCUITS) {
  const p = artifactPaths(name);
  const phase2Contributions = await phase2(name);
  const vk = await zKey.exportVerificationKey(p.zkey, logger);
  const vkJson = stableJson(vk);
  writeFileSync(p.vkeyJson, vkJson);
  const vkJsonSha = sha256Text(vkJson);
  writeFileSync(p.vkRust, rustVk(name, vk, vkJsonSha));
  const info = await r1csApi.info(p.r1cs, logger);
  const files = sourceFiles(sourcePath(name));
  sources[name] = files;
  circuits[name] = {
    name,
    sourceSha256: sourceTreeHash(files),
    circomVersion,
    compilerFlags: [...COMPILER_FLAGS, "-l", toRepoPosix(circomlibParent())],
    constraints: info.nConstraints,
    nPublic: vk.nPublic,
    publicInputOrder: [...PUBLIC_INPUTS[name]],
    r1csSha256: sha256File(p.r1cs),
    wasmSha256: sha256File(p.wasm),
    symSha256: sha256File(p.sym),
    zkeySha256: sha256File(p.zkey),
    vkeyJsonSha256: vkJsonSha,
    vkRustSha256: sha256File(p.vkRust),
    ptau: {
      file: toRepoPosix(PTAU_PATH),
      sha256: ptauSha,
      power: PTAU_POWER,
      source: secretContribution
        ? "local development generation with snarkjs 0.7.6 (OS-entropy contribution + beacon); not a trusted ceremony"
        : "local deterministic development generation with snarkjs 0.7.6 (public beacon only); not a trusted ceremony",
    },
    setup: {
      kind: "development",
      contributions: [...phase1Contributions.map((c) => `phase1: ${c}`), ...phase2Contributions.map((c) => `phase2: ${c}`)],
      beacon: `sha256("veilo/dev-setup/v1/phase2/${name}") = ${beaconHash(`phase2/${name}`)}, 2^${BEACON_ITERATIONS_EXP} iterations`,
    },
  };
}

const manifest = {
  schemaVersion: 1,
  protocolVersion: 1,
  encodingVersion: "v1",
  warning:
    "DEVELOPMENT SETUP, NOT A TRUSTED CEREMONY. With the default deterministic setup the toxic waste is derivable " +
    "from public beacons, so anyone can forge proofs for these keys. Use only with devnet test funds.",
  snarkjsVersion: "0.7.6",
  circomlibVersion: circomlibVersion(),
  deterministic: !secretContribution,
  ptau: {
    file: toRepoPosix(PTAU_PATH),
    sha256: ptauSha,
    power: PTAU_POWER,
    procedure: secretContribution
      ? ["powersoftau new bn128 15", "powersoftau contribute (OS entropy)", "powersoftau beacon", "powersoftau prepare phase2"]
      : ["powersoftau new bn128 15", `powersoftau beacon ${beaconHash("phase1")} 10`, "powersoftau prepare phase2"],
    beacon: `sha256("veilo/dev-setup/v1/phase1") = ${beaconHash("phase1")}, 2^${BEACON_ITERATIONS_EXP} iterations`,
  },
  circuits,
  sources,
};

const serialized = stableJson(manifest);
const existing = existsSync(MANIFEST_PATH) ? readFileSync(MANIFEST_PATH, "utf8").replace(/\r\n/g, "\n") : null;
if (existing !== null && existing !== serialized && !updateManifest) {
  const prev = readJson<typeof manifest>(MANIFEST_PATH);
  console.error("Built circuit artifacts do not match artifacts/circuits/manifest.json.");
  for (const name of MAIN_CIRCUITS) {
    const a = JSON.stringify(prev.circuits?.[name]);
    const b = JSON.stringify(circuits[name]);
    if (a !== b) console.error(`  ${name}: differs`);
  }
  if (JSON.stringify(prev.ptau) !== JSON.stringify(manifest.ptau)) console.error("  ptau: differs");
  console.error("Rebuild from a clean circuits/build, or pass --update-manifest for an intended circuit/setup change.");
  process.exit(1);
}
if (existing !== serialized) {
  writeFileSync(MANIFEST_PATH, serialized);
  log("wrote artifacts/circuits/manifest.json");
} else {
  log("artifacts match artifacts/circuits/manifest.json");
}

// snarkjs keeps curve worker threads alive; exit explicitly once all files are written.
process.exit(0);
