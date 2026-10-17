// Loopback solana-test-validator in the toolchain container: the deployed program binary is
// preloaded at the devnet program id (upgrade authority = the local deployer) and a 6-decimal
// mint is preloaded at the pinned mint address with a local mint authority. Nothing here touches
// devnet; the services refuse this chain unless VEILO_CHAIN_PROFILE=local-test-validator.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { getAddressEncoder, type Address } from "@solana/kit";
import { DEMO_TOKEN_MINT } from "@veilo/contracts";
import { TOOLCHAIN_IMAGE } from "../toolchain-image.mjs";
import { makeRpc, REPO, sleep, TOKEN_PROGRAM, type Rpc } from "../devnet/lib";

export const PROGRAM_SO = "target/deploy/privacy_pool.so";
const MINT_RENT = 1_461_600;

export interface LocalValidator {
  name: string;
  rpcUrl: string;
  rpc: Rpc;
  genesisHash: string;
  stop(): void;
}

function docker(args: string[], allowFail = false): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw new Error(`docker failed to start: ${r.error.message}`);
  if (!allowFail && r.status !== 0) throw new Error(`docker ${args[0]} exited ${r.status}: ${(r.stderr || r.stdout).slice(0, 400)}`);
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Solana account dump (solana account --output json) for an initialized SPL Token mint. */
function mintAccountJson(mintAuthority: string): string {
  const data = Buffer.alloc(82);
  data.writeUInt32LE(1, 0);
  Buffer.from(getAddressEncoder().encode(mintAuthority as Address)).copy(data, 4);
  data.writeBigUInt64LE(0n, 36);
  data[44] = 6;
  data[45] = 1;
  data.writeUInt32LE(0, 46);
  return JSON.stringify({
    pubkey: DEMO_TOKEN_MINT,
    account: { lamports: MINT_RENT, data: [data.toString("base64"), "base64"], owner: TOKEN_PROGRAM, executable: false, rentEpoch: 0, space: 82 },
  });
}

export function validatorRunning(name: string): boolean {
  const r = docker(["inspect", "-f", "{{.State.Running}}", name], true);
  return r.status === 0 && r.stdout.trim() === "true";
}

export function stopValidator(name: string): void {
  docker(["rm", "-f", name], true);
}

/**
 * Starts (or, with reuse, attaches to) the container. A fresh start resets the ledger, so every
 * run begins from genesis with only the program and mint preloaded.
 */
export async function startValidator(o: {
  name: string;
  rpcPort: number;
  workDir: string;
  programId: string;
  upgradeAuthority: string;
  mintAuthority: string;
  reuse?: boolean;
}): Promise<LocalValidator> {
  const rpcUrl = `http://127.0.0.1:${o.rpcPort}`;
  if (!(o.reuse && validatorRunning(o.name))) {
    stopValidator(o.name);
    mkdirSync(o.workDir, { recursive: true });
    const mintPath = join(o.workDir, "mint-account.json");
    writeFileSync(mintPath, mintAccountJson(o.mintAuthority));
    const rel = (p: string) => relative(REPO, p).split("\\").join("/");
    const cmd = [
      "exec solana-test-validator --ledger /tmp/ledger --reset --bind-address $(hostname -i) --rpc-port 8899",
      "--limit-ledger-size 200000000",
      `--upgradeable-program ${o.programId} /workspace/${PROGRAM_SO} ${o.upgradeAuthority}`,
      `--account ${DEMO_TOKEN_MINT} /workspace/${rel(mintPath)}`,
      "> /tmp/validator.out 2>&1",
    ].join(" ");
    docker([
      "run",
      "-d",
      "--name",
      o.name,
      "--security-opt",
      "seccomp=unconfined",
      "-p",
      `127.0.0.1:${o.rpcPort}:8899`,
      "-p",
      `127.0.0.1:${o.rpcPort + 1}:8900`,
      "-v",
      `${REPO}:/workspace`,
      "-w",
      "/workspace",
      TOOLCHAIN_IMAGE,
      "sh",
      "-c",
      cmd,
    ]);
  }
  const rpc = makeRpc(rpcUrl);
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const slot = await rpc.getSlot({ commitment: "finalized" }).send();
      const mint = await rpc.getAccountInfo(DEMO_TOKEN_MINT as Address, { encoding: "base64", commitment: "finalized" }).send();
      if (slot > 0n && mint.value) break;
    } catch {
      // not up yet
    }
    if (!validatorRunning(o.name)) {
      const logs = docker(["exec", o.name, "tail", "-20", "/tmp/validator.out"], true).stdout || docker(["logs", "--tail", "20", o.name], true).stdout;
      throw new Error(`local validator container ${o.name} exited: ${logs.slice(-800)}`);
    }
    if (Date.now() > deadline) throw new Error("local validator did not become ready within 120 s");
    await sleep(1_000);
  }
  const genesisHash = await rpc.getGenesisHash().send();
  return { name: o.name, rpcUrl, rpc, genesisHash, stop: () => stopValidator(o.name) };
}
