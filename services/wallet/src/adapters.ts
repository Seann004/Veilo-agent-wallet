import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { address, createSolanaRpc, devnet, signature as toSignature, type Address, type Blockhash } from "@solana/kit";
import {
  publicStateWire,
  recoveryViewWire,
  withdrawalViewWire,
  type PublicStateWire,
  type RecoveryRequestWire,
  type RecoveryViewWire,
  type WithdrawalRequestWire,
  type WithdrawalViewWire,
} from "@veilo/contracts/relayer";
import { parseDeploymentManifest, prove, type CircuitWitness, type DeploymentManifest, type GeneratedProof } from "@veilo/privacy-sdk";
import { decodeWireTransaction, messageHashOf } from "@veilo/x402-client";
import {
  PortUnavailableError,
  type ChainPort,
  type ControlNoteRef,
  type ControlPort,
  type ControlPurchase,
  type LivePurchaseRef,
  type ProverPort,
  type RelayerPort,
  type SignatureStatus,
} from "./ports";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A non-2xx reply from another Veilo service, with its API error code when present. */
export class ServiceCallError extends Error {
  override readonly name = "ServiceCallError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class JsonClient {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike,
    private readonly service: string,
  ) {}

  async call<T>(method: string, path: string, body?: unknown, allow404 = false): Promise<T | null> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base.replace(/\/$/, "")}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new PortUnavailableError(`${this.service} unreachable (${(error as Error).name})`);
    }
    if (allow404 && res.status === 404) return null;
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      throw new ServiceCallError(res.status, "INTERNAL_ERROR", `${this.service} returned a non-JSON reply`);
    }
    if (!res.ok) {
      const err = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new ServiceCallError(res.status, err?.code ?? "INTERNAL_ERROR", `${this.service}: ${err?.message ?? `HTTP ${res.status}`}`);
    }
    return parsed as T;
  }
}

export class HttpControlPort implements ControlPort {
  private readonly c: JsonClient;
  constructor(baseUrl: string, walletToken: string, fetchImpl: FetchLike = fetch) {
    this.c = new JsonClient(baseUrl, walletToken, fetchImpl, "control");
  }
  async purchase(id: string): Promise<ControlPurchase> {
    return (await this.c.call<{ purchase: ControlPurchase }>("GET", `/internal/wallet/purchases/${id}`))!.purchase;
  }
  async ownerSession(sessionToken: string, csrfToken: string | undefined) {
    return (await this.c.call<{ workspaceId: string; ownerPubkey: string; csrfValid: boolean }>("POST", "/internal/wallet/owner-session", {
      sessionToken,
      ...(csrfToken !== undefined ? { csrfToken } : {}),
    }))!;
  }
  async registerDepositNote(commitment: string, value: bigint) {
    await this.c.call("POST", "/internal/wallet/notes", { commitment, value: value.toString() });
  }
  async confirmChange(purchaseId: string) {
    await this.c.call("POST", "/internal/wallet/notes/change-inserted", { purchaseId });
  }
  async noteExited(commitment: string, observedAtMs: number) {
    await this.c.call("POST", "/internal/wallet/notes/exited", { commitment, observedAtMs });
  }
  async merchantExpired(purchaseId: string) {
    return (await this.c.call<{ purchase: ControlPurchase }>("POST", `/internal/wallet/purchases/${purchaseId}/merchant-expired`, {}))!.purchase;
  }
  async markRecoverable(purchaseId: string, reason: string) {
    return (await this.c.call<{ purchase: ControlPurchase }>("POST", `/internal/wallet/purchases/${purchaseId}/recoverable`, { reason }))!.purchase;
  }
  async recordRecovery(purchaseId: string, r: { recoveredPrincipal: bigint; tokenFeesPaid: bigint; sponsorLamportsSpent: bigint; observedAtMs: number }) {
    await this.c.call("POST", `/internal/wallet/purchases/${purchaseId}/recovered`, {
      recoveredPrincipal: r.recoveredPrincipal.toString(),
      tokenFeesPaid: r.tokenFeesPaid.toString(),
      sponsorLamportsSpent: r.sponsorLamportsSpent.toString(),
      observedAtMs: r.observedAtMs,
    });
  }
  async livePurchases(): Promise<LivePurchaseRef[]> {
    return (await this.c.call<{ purchases: LivePurchaseRef[] }>("GET", "/internal/wallet/purchases/live"))!.purchases;
  }
  async notes(): Promise<ControlNoteRef[]> {
    return (await this.c.call<{ notes: ControlNoteRef[] }>("GET", "/internal/wallet/notes"))!.notes;
  }
}

export class HttpRelayerPort implements RelayerPort {
  private readonly c: JsonClient;
  constructor(baseUrl: string, walletToken: string, fetchImpl: FetchLike = fetch) {
    this.c = new JsonClient(baseUrl, walletToken, fetchImpl, "relayer");
  }
  async deployment(): Promise<DeploymentManifest> {
    return parseDeploymentManifest((await this.c.call<{ manifest: unknown }>("GET", "/deployment"))!.manifest);
  }
  async publicState(): Promise<PublicStateWire> {
    return publicStateWire.parse(await this.c.call("GET", "/public-state"));
  }
  async submitWithdrawal(req: WithdrawalRequestWire): Promise<WithdrawalViewWire> {
    return withdrawalViewWire.parse(await this.c.call("POST", "/withdrawals", req));
  }
  async withdrawal(id: string): Promise<WithdrawalViewWire | null> {
    const v = await this.c.call("GET", `/withdrawals/${id}`, undefined, true);
    return v === null ? null : withdrawalViewWire.parse(v);
  }
  async submitRecovery(req: RecoveryRequestWire): Promise<RecoveryViewWire> {
    return recoveryViewWire.parse(await this.c.call("POST", "/recoveries", req));
  }
  async recovery(id: string): Promise<RecoveryViewWire | null> {
    const v = await this.c.call("GET", `/recoveries/${id}`, undefined, true);
    return v === null ? null : recoveryViewWire.parse(v);
  }
}

export function createRpcChainPort(rpcUrl: string): ChainPort {
  const rpc = createSolanaRpc(devnet(rpcUrl));
  return {
    async finalizedSlot() {
      return rpc.getSlot({ commitment: "finalized" }).send();
    },
    async finalizedBlockHeight() {
      return rpc.getBlockHeight({ commitment: "finalized" }).send();
    },
    async latestBlockhash() {
      const { value } = await rpc.getLatestBlockhash({ commitment: "finalized" }).send();
      return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
    },
    async account(addr: Address) {
      const { value } = await rpc.getAccountInfo(addr, { encoding: "base64", commitment: "finalized" }).send();
      if (!value) return null;
      return { data: new Uint8Array(Buffer.from(value.data[0], "base64")), lamports: value.lamports, owner: value.owner };
    },
    async tokenBalance(ata: Address) {
      try {
        const { value } = await rpc.getTokenAccountBalance(ata, { commitment: "finalized" }).send();
        return BigInt(value.amount);
      } catch {
        const acct = await rpc.getAccountInfo(ata, { encoding: "base64", commitment: "finalized" }).send();
        if (!acct.value) return null;
        throw new PortUnavailableError("token balance unavailable");
      }
    },
    async signatureStatus(sig: string): Promise<SignatureStatus | null> {
      const { value } = await rpc.getSignatureStatuses([toSignature(sig)], { searchTransactionHistory: true }).send();
      const s = value[0];
      if (!s || s.confirmationStatus === null) return null;
      return { confirmationStatus: s.confirmationStatus, err: s.err, slot: s.slot };
    },
    async isBlockhashValid(blockhash: string) {
      const { value } = await rpc.isBlockhashValid(blockhash as Blockhash, { commitment: "processed" }).send();
      return value;
    },
    async findTransaction(addr: Address, messageHash: string) {
      const sigs = await rpc.getSignaturesForAddress(address(addr), { limit: 50, commitment: "confirmed" }).send();
      for (const s of sigs) {
        const tx = await rpc
          .getTransaction(s.signature, { commitment: "confirmed", encoding: "base64", maxSupportedTransactionVersion: 0 })
          .send();
        if (!tx) continue;
        const decoded = decodeWireTransaction(tx.transaction[0]);
        if (messageHashOf(new Uint8Array(decoded.messageBytes)) !== messageHash) continue;
        return { signature: s.signature, err: tx.meta?.err ?? null, finalized: s.confirmationStatus === "finalized" };
      }
      return null;
    },
  };
}

interface CircuitManifestEntry {
  wasmSha256: string;
  zkeySha256: string;
}

/** Local snarkjs prover over hash-pinned artifacts (artifacts/circuits/manifest.json). */
export class SnarkjsProver implements ProverPort {
  private readonly manifest: Record<string, CircuitManifestEntry>;

  constructor(
    repoRoot: string,
    private readonly buildDir = join(repoRoot, "circuits", "build"),
  ) {
    const m = JSON.parse(readFileSync(join(repoRoot, "artifacts", "circuits", "manifest.json"), "utf8")) as { circuits: Record<string, CircuitManifestEntry> };
    this.manifest = m.circuits;
  }

  paths(circuit: "spend" | "exit" | "insert") {
    return {
      wasmPath: join(this.buildDir, circuit, `${circuit}_js`, `${circuit}.wasm`),
      zkeyPath: join(this.buildDir, "zkey", `${circuit}_final.zkey`),
    };
  }

  available(): boolean {
    return (["spend", "exit"] as const).every((c) => existsSync(this.paths(c).wasmPath) && existsSync(this.paths(c).zkeyPath));
  }

  circuitHashes(): Record<"spend" | "insert" | "exit", { wasmSha256: string; zkeySha256: string; vkeyJsonSha256: string }> {
    return this.manifest as never;
  }

  prove(circuit: "spend" | "exit" | "insert", witness: CircuitWitness): Promise<GeneratedProof> {
    const m = this.manifest[circuit];
    if (!m) throw new PortUnavailableError(`no pinned artifacts for ${circuit}`);
    return prove(witness, { ...this.paths(circuit), wasmSha256: m.wasmSha256, zkeySha256: m.zkeySha256 });
  }
}
