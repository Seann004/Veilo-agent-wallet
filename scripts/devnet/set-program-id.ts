// Points declare_id!, Anchor.toml and the published IDL at the program id recorded by
// keys:init. Rebuild afterwards with `pnpm tc -- anchor build --ignore-keys`.
//   pnpm program:set-id [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { address, getAddressDecoder, getAddressEncoder } from "@solana/kit";
import { hasFlag, readRoles, REPO } from "./lib";

const LIB_RS = join(REPO, "programs", "privacy-pool", "src", "lib.rs");
const ANCHOR_TOML = join(REPO, "Anchor.toml");
const IDL = join(REPO, "artifacts", "program", "privacy_pool.json");
const DEPLOYER_IN_CONTAINER = "/workspace/work/keys/devnet/deployer.json";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ConstSeed = { kind: "const"; value: number[] };

const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

function constAddress(node: Json | undefined): string | null {
  if (!node || typeof node !== "object" || Array.isArray(node) || node.kind !== "const") return null;
  const v = node.value;
  return Array.isArray(v) && v.length === 32 && v.every((b) => typeof b === "number") ? getAddressDecoder().decode(new Uint8Array(v as number[])) : null;
}

/** Visits the first seed of every ProgramData PDA (seeds = [program id] under the upgradeable loader). */
function programDataSeeds(node: Json, visit: (seed: ConstSeed) => void): void {
  if (Array.isArray(node)) for (const n of node) programDataSeeds(n, visit);
  else if (node && typeof node === "object") {
    const pda = node.pda;
    if (pda && typeof pda === "object" && !Array.isArray(pda) && constAddress(pda.program) === UPGRADEABLE_LOADER && Array.isArray(pda.seeds) && constAddress(pda.seeds[0]) !== null) {
      visit(pda.seeds[0] as unknown as ConstSeed);
    }
    for (const child of Object.values(node)) programDataSeeds(child, visit);
  }
}

/** The program id the IDL's ProgramData seeds encode, or null if there are none or they disagree. */
function idlProgramDataSeedId(idl: Json): string | null {
  const ids = new Set<string>();
  programDataSeeds(idl, (seed) => ids.add(getAddressDecoder().decode(new Uint8Array(seed.value))));
  return ids.size === 1 ? [...ids][0]! : null;
}

export function currentProgramIds(): { declareId: string | null; anchorToml: string | null; idl: string | null; idlProgramDataSeed: string | null } {
  const lib = /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/.exec(readFileSync(LIB_RS, "utf8"));
  const toml = /\[programs\.devnet\]\s*\nprivacy_pool\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/.exec(readFileSync(ANCHOR_TOML, "utf8"));
  const parsed = JSON.parse(readFileSync(IDL, "utf8")) as Json & { address?: string };
  return { declareId: lib?.[1] ?? null, anchorToml: toml?.[1] ?? null, idl: parsed.address ?? null, idlProgramDataSeed: idlProgramDataSeedId(parsed) };
}

function main(): void {
  const id = readRoles().roles.programId.publicKey;
  const cur = currentProgramIds();
  if (hasFlag("--check")) {
    const ok = cur.declareId === id && cur.anchorToml === id && cur.idl === id && cur.idlProgramDataSeed === id;
    console.log(JSON.stringify({ expected: id, ...cur, ok }, null, 2));
    process.exit(ok ? 0 : 1);
  }
  const lib = readFileSync(LIB_RS, "utf8").replace(/declare_id!\("[1-9A-HJ-NP-Za-km-z]{32,44}"\)/, `declare_id!("${id}")`);
  writeFileSync(LIB_RS, lib);
  const toml = readFileSync(ANCHOR_TOML, "utf8")
    .replace(/(\[programs\.devnet\]\s*\nprivacy_pool\s*=\s*)"[^"]*"/, `$1"${id}"`)
    .replace(/(\[provider\][^[]*?wallet\s*=\s*)"[^"]*"/, `$1"${DEPLOYER_IN_CONTAINER}"`);
  writeFileSync(ANCHOR_TOML, toml);
  // The IDL's ProgramData PDA seed is the program id's bytes; it must follow the address.
  const idl = JSON.parse(readFileSync(IDL, "utf8")) as { [key: string]: Json };
  const idBytes = [...getAddressEncoder().encode(address(id))];
  programDataSeeds(idl, (seed) => {
    seed.value = idBytes;
  });
  idl.address = id;
  writeFileSync(IDL, JSON.stringify(idl, null, 2));
  const after = currentProgramIds();
  if (after.declareId !== id || after.anchorToml !== id || after.idl !== id || after.idlProgramDataSeed !== id) throw new Error("program id was not applied everywhere");
  console.log(`program id ${id} applied to programs/privacy-pool/src/lib.rs, Anchor.toml and artifacts/program/privacy_pool.json (address and ProgramData seed)`);
  console.log("next: pnpm tc -- anchor build --ignore-keys   (then pnpm test:program)");
}

if (process.argv[1]?.endsWith("set-program-id.ts")) {
  try {
    main();
  } catch (error) {
    console.error(`program:set-id failed: ${(error as Error).message}`);
    process.exit(1);
  }
}
