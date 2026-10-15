// Generates or checks artifacts/vectors/v1.json against the TypeScript reference.
//   tsx packages/privacy-sdk/scripts/vectors.ts generate [--force-protocol-change]
//   tsx packages/privacy-sdk/scripts/vectors.ts check
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVectors } from "../src/vectors";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const vectorsPath = resolve(repoRoot, "artifacts/vectors/v1.json");

const [mode, ...flags] = process.argv.slice(2);
const serialized = `${JSON.stringify(await buildVectors(), null, 2)}\n`;
const existing = existsSync(vectorsPath) ? readFileSync(vectorsPath, "utf8").replace(/\r\n/g, "\n") : null;

if (mode === "generate") {
  if (existing !== null && existing !== serialized && !flags.includes("--force-protocol-change")) {
    console.error(
      "artifacts/vectors/v1.json differs from the TypeScript reference. Changing it is a protocol change;\n" +
        "rerun with --force-protocol-change only together with new circuit artifacts and a protocol changelog entry.",
    );
    process.exit(1);
  }
  mkdirSync(dirname(vectorsPath), { recursive: true });
  writeFileSync(vectorsPath, serialized);
  console.log(existing === serialized ? "vectors unchanged" : "wrote artifacts/vectors/v1.json");
} else if (mode === "check") {
  if (existing === null) {
    console.error("artifacts/vectors/v1.json is missing; run pnpm vectors:generate");
    process.exit(1);
  }
  if (existing !== serialized) {
    console.error("TypeScript reference does not reproduce artifacts/vectors/v1.json");
    process.exit(1);
  }
  console.log("TypeScript: artifacts/vectors/v1.json reproduced");
} else {
  console.error("usage: vectors.ts generate|check");
  process.exit(2);
}
