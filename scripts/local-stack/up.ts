// Boots the local stack (validator, facilitator, FIXTURE provider, all services) for manual
// inspection, funds the pool and keeps it running until Ctrl-C.
//   pnpm tsx scripts/local-stack/up.ts [--name local-dev] [--base-port 5300] [--notes 2]
import { argValue } from "../devnet/lib";
import { createLocalStack } from "./stack";

const name = argValue("--name") ?? "local-dev";
const basePort = Number(argValue("--base-port") ?? "5300");
const notes = Number(argValue("--notes") ?? "2");

const t0 = Date.now();
const stack = await createLocalStack({ name, basePort, reuse: process.argv.includes("--reuse") });
console.log(`stack up in ${Math.round((Date.now() - t0) / 1000)} s: control ${stack.controlUrl}, rpc ${stack.validator.rpcUrl}`);
if (notes > 0) {
  await stack.owner.activateSeededPolicies();
  await stack.fundPool(Array.from({ length: notes }, () => 2_000_000n));
  console.log(`pool funded (${notes} notes) after ${Math.round((Date.now() - t0) / 1000)} s`);
}
const stop = async () => {
  await stack.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
if (process.argv.includes("--exit")) {
  await stack.services.killAll();
  process.exit(0);
}
