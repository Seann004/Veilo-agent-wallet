// Points declare_id!, Anchor.toml and the published IDL at the program id recorded by
// keys:init. Rebuild afterwards with `pnpm tc -- anchor build --ignore-keys`.
//   pnpm program:set-id [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasFlag, readRoles, REPO } from "./lib";

const LIB_RS = join(REPO, "programs", "privacy-pool", "src", "lib.rs");
const ANCHOR_TOML = join(REPO, "Anchor.toml");
const IDL = join(REPO, "artifacts", "program", "privacy_pool.json");
const DEPLOYER_IN_CONTAINER = "/workspace/work/keys/devnet/deployer.json";

export function currentProgramIds(): { declareId: string | null; anchorToml: string | null; idl: string | null } {
  const lib = /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/.exec(readFileSync(LIB_RS, "utf8"));
  const toml = /\[programs\.devnet\]\s*\nprivacy_pool\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/.exec(readFileSync(ANCHOR_TOML, "utf8"));
  const idl = (JSON.parse(readFileSync(IDL, "utf8")) as { address?: string }).address ?? null;
  return { declareId: lib?.[1] ?? null, anchorToml: toml?.[1] ?? null, idl };
}

function main(): void {
  const id = readRoles().roles.programId.publicKey;
  const cur = currentProgramIds();
  if (hasFlag("--check")) {
    const ok = cur.declareId === id && cur.anchorToml === id && cur.idl === id;
    console.log(JSON.stringify({ expected: id, ...cur, ok }, null, 2));
    process.exit(ok ? 0 : 1);
  }
  const lib = readFileSync(LIB_RS, "utf8").replace(/declare_id!\("[1-9A-HJ-NP-Za-km-z]{32,44}"\)/, `declare_id!("${id}")`);
  writeFileSync(LIB_RS, lib);
  const toml = readFileSync(ANCHOR_TOML, "utf8")
    .replace(/(\[programs\.devnet\]\s*\nprivacy_pool\s*=\s*)"[^"]*"/, `$1"${id}"`)
    .replace(/(\[provider\][^[]*?wallet\s*=\s*)"[^"]*"/, `$1"${DEPLOYER_IN_CONTAINER}"`);
  writeFileSync(ANCHOR_TOML, toml);
  const idlText = readFileSync(IDL, "utf8");
  writeFileSync(IDL, idlText.replace(/^(\s*"address":\s*)"[^"]*"/m, `$1"${id}"`));
  const after = currentProgramIds();
  if (after.declareId !== id || after.anchorToml !== id || after.idl !== id) throw new Error("program id was not applied everywhere");
  console.log(`program id ${id} applied to programs/privacy-pool/src/lib.rs, Anchor.toml and artifacts/program/privacy_pool.json`);
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
