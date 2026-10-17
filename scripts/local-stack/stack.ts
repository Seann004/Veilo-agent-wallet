// The whole local stack: validator, self-hosted facilitator, FIXTURE provider, fault proxies on
// every inter-service link, and the five services as separate processes. Used by
// `pnpm test:integration` and by `pnpm demo:run -- --local-rehearsal`.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { approveInsertedDeposits } from "../demo/approve";
import { loadSigner, REPO, type Rpc } from "../devnet/lib";
import { bootstrapLocal, LINKS, portPlan, type Bootstrapped, type Link, type PortPlan } from "./bootstrap";
import { mintTestUsdc } from "./chain";
import { startLocalFacilitator, type LocalFacilitator } from "./facilitator";
import { signTextWithKeyFile } from "./keys";
import { startMockProvider, type MockProvider } from "./mock-provider";
import { OwnerClient } from "./owner-client";
import { FaultProxy } from "./proxy";
import { ServiceProcesses, type ServiceName } from "./services";

export interface LocalStack extends Bootstrapped {
  ports: PortPlan;
  rpc: Rpc;
  facilitator: LocalFacilitator;
  provider: MockProvider;
  proxies: Record<Link, FaultProxy>;
  services: ServiceProcesses;
  owner: OwnerClient;
  controlUrl: string;
  login(): Promise<void>;
  /** Mints test USDC to the owner and deposits `amounts` as separate notes; returns when all are spendable. */
  fundPool(amounts: bigint[]): Promise<void>;
  /** Publishes approved labels for inserted deposits by the configured participants. */
  approveRoot(): Promise<boolean>;
  close(opts?: { keepValidator?: boolean }): Promise<void>;
}

const LINK_TARGET = (p: PortPlan, rpcUrl: string): Record<Link, string> => ({
  "control→wallet": `http://127.0.0.1:${p.wallet}`,
  "control→gateway": `http://127.0.0.1:${p.gateway}`,
  "wallet→control": `http://127.0.0.1:${p.control}`,
  "wallet→relayer": `http://127.0.0.1:${p.relayer}`,
  "runner→control": `http://127.0.0.1:${p.control}`,
  "gateway→facilitator": `http://127.0.0.1:${p.facilitator}`,
  "relayer→rpc": rpcUrl,
  "wallet→rpc": rpcUrl,
  "gateway→rpc": rpcUrl,
});

export async function createLocalStack(o: { name: string; dir?: string; basePort: number; extraEnv?: Record<string, string>; reuse?: boolean; log?: (m: string) => void }): Promise<LocalStack> {
  const dir = o.dir ?? join(REPO, "work", o.name);
  if (!o.reuse) rmSync(dir, { recursive: true, force: true });
  const ports = portPlan(o.basePort);
  const boot = await bootstrapLocal({ name: `veilo-${o.name}-validator`, dir, ports, reuse: o.reuse ?? false, ...(o.extraEnv ? { extraEnv: o.extraEnv } : {}), ...(o.log ? { log: o.log } : {}) });
  const rpc = boot.validator.rpc;
  const facilitator = await startLocalFacilitator({ rpcUrl: boot.validator.rpcUrl, feePayerKeyPath: boot.keys.facilitatorFeePayer.path, port: ports.facilitator });
  const provider = await startMockProvider(ports.provider);
  const targets = LINK_TARGET(ports, boot.validator.rpcUrl);
  const proxies = {} as Record<Link, FaultProxy>;
  for (const l of LINKS) {
    proxies[l] = new FaultProxy(l, ports.proxies[l], targets[l]);
    await proxies[l].start();
  }
  const px = (l: Link) => proxies[l].url;
  const services = new ServiceProcesses({
    envFile: boot.envFile,
    logDir: join(dir, "logs"),
    ports: { control: ports.control, runner: ports.runner, wallet: ports.wallet, gateway: ports.gateway, relayer: ports.relayer },
    env: {
      control: { CONTROL_PORT: String(ports.control), WALLET_PORT: String(ports.proxies["control→wallet"]), GATEWAY_PORT: String(ports.proxies["control→gateway"]) },
      wallet: { WALLET_PORT: String(ports.wallet), VEILO_CONTROL_URL: px("wallet→control"), VEILO_RELAYER_URL: px("wallet→relayer"), DEVNET_RPC_URL: px("wallet→rpc") },
      relayer: { RELAYER_PORT: String(ports.relayer), DEVNET_RPC_URL: px("relayer→rpc") },
      gateway: { GATEWAY_PORT: String(ports.gateway), FACILITATOR_URL: px("gateway→facilitator"), DEVNET_RPC_URL: px("gateway→rpc") },
      runner: { RUNNER_PORT: String(ports.runner), CONTROL_PORT: String(ports.proxies["runner→control"]) },
    },
  });
  await services.startAll();
  const controlUrl = `http://127.0.0.1:${ports.control}`;
  const owner = new OwnerClient(controlUrl, `http://127.0.0.1:${ports.wallet}`, `http://localhost:${ports.dashboard}`);
  const login = () => owner.login(boot.keys.owner.publicKey, (m) => signTextWithKeyFile(boot.keys.owner.path, m));
  await login();

  const approveRoot = async (): Promise<boolean> =>
    (
      await approveInsertedDeposits({
        rpc,
        rpcUrl: boot.validator.rpcUrl,
        manifest: boot.manifest,
        labelsPath: join(dir, "approved-labels.json"),
        participants: new Set(boot.env.APPROVED_PARTICIPANTS!.split(",")),
        approvalKeyPath: boot.keys.approvalAuthority.path,
        workDir: join(dir, "data"),
      })
    ).signature !== null;

  const fundPool = async (amounts: bigint[]) => {
    const payer = await loadSigner(boot.keys.deployer.path);
    const mintAuth = await loadSigner(boot.keys.mintAuthority.path);
    const ownerSigner = await loadSigner(boot.keys.owner.path);
    const total = amounts.reduce((a, b) => a + b, 0n);
    const before = await owner.notes();
    const spendableBefore = BigInt(before.totals.spendable.amount);
    await mintTestUsdc(rpc, boot.validator.rpcUrl, payer, mintAuth, ownerSigner.address, total);
    for (const a of amounts) await owner.deposit(rpc, ownerSigner, a);
    // The relayer's crank inserts the deposits; approval follows insertion.
    const deadline = Date.now() + 600_000;
    for (;;) {
      await approveRoot();
      const s = await owner.notes();
      if (BigInt(s.totals.spendable.amount) >= spendableBefore + total) return;
      if (Date.now() > deadline) throw new Error(`deposits not spendable in time: ${JSON.stringify(s.totals)}`);
      await new Promise((r) => setTimeout(r, 4_000));
    }
  };

  return {
    ...boot,
    ports,
    rpc,
    facilitator,
    provider,
    proxies,
    services,
    owner,
    controlUrl,
    login,
    fundPool,
    approveRoot,
    async close(opts = {}) {
      await services.killAll();
      for (const p of Object.values(proxies)) await p.close();
      await provider.close();
      await facilitator.close();
      if (!opts.keepValidator) boot.validator.stop();
    },
  };
}

export type { ServiceName };
