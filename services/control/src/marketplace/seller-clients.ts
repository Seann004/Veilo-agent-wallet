import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { ControlError } from "../errors";
import { GatewayClient, GatewayUnreachableError } from "../integration/gateway-client";
import { KeyedLock } from "../integration/locks";
import { SellerOriginDenied, type SellerOriginPolicy } from "./origin-policy";
import { readSecretFile, writeSecretFileOnce } from "./secret-files";

/** Approved services whose key starts with this prefix are paid through their seller host. */
export const LISTING_SERVICE_PREFIX = "listing:";

const accountReplySchema = z.object({ accountId: z.string().min(1).max(200), token: z.string().regex(/^[A-Za-z0-9._~+/=-]{16,512}$/) }).passthrough();

export interface SellerClientsOptions {
  policy: SellerOriginPolicy;
  /** Directory for per-seller account tokens (0700); each token file is 0600. */
  tokenDir: string;
  timeoutMs?: number;
}

/**
 * One authenticated client per seller host, keyed by origin and gateway identity. Seller account
 * tokens live only in 0600 files and in memory; they are never logged or stored in the ledger.
 */
export class SellerClients {
  readonly policy: SellerOriginPolicy;
  readonly #tokenDir: string;
  readonly #timeoutMs: number;
  readonly #clients = new Map<string, GatewayClient>();
  readonly #lock = new KeyedLock();

  constructor(o: SellerClientsOptions) {
    this.policy = o.policy;
    this.#tokenDir = o.tokenDir;
    this.#timeoutMs = o.timeoutMs ?? 90_000;
  }

  static keyFor(origin: string, identity: string): string {
    return createHash("sha256").update(`veilo:seller-host:v1\n${origin}\n${identity}`).digest("hex").slice(0, 40);
  }

  tokenPath(origin: string, identity: string): string {
    return join(this.#tokenDir, `${SellerClients.keyFor(origin, identity)}.token`);
  }

  async clientFor(s: { origin: string; gatewayIdentity: string; workspaceId: string }): Promise<GatewayClient> {
    const problem = this.policy.problem(s.origin);
    if (problem) throw new ControlError("SERVICE_NOT_ALLOWED", problem);
    const key = SellerClients.keyFor(s.origin, s.gatewayIdentity);
    const cached = this.#clients.get(key);
    if (cached) return cached;
    return this.#lock.run(key, async () => {
      const again = this.#clients.get(key);
      if (again) return again;
      const path = this.tokenPath(s.origin, s.gatewayIdentity);
      const token = readSecretFile(path) ?? (await this.#createAccount(s.origin, s.workspaceId, path));
      const client = new GatewayClient({
        baseUrl: s.origin,
        accountToken: token,
        identity: s.gatewayIdentity,
        fetch: this.policy.fetchFor(s.origin),
        timeoutMs: this.#timeoutMs,
      });
      this.#clients.set(key, client);
      return client;
    });
  }

  async #createAccount(origin: string, workspaceId: string, path: string): Promise<string> {
    let res: Response;
    try {
      res = await this.policy.fetchFor(origin)(`${origin}/v1/accounts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      if (error instanceof SellerOriginDenied) throw new ControlError("SERVICE_NOT_ALLOWED", error.message);
      throw new GatewayUnreachableError(`seller host account request failed: ${(error as Error).name}`);
    }
    const text = await res.text();
    if (res.status === 409) {
      throw new ControlError("RECOVERY_REQUIRED", "seller host already has an account for this workspace but the local token file is missing");
    }
    if (res.status !== 200 && res.status !== 201) throw new GatewayUnreachableError(`seller host account unavailable (HTTP ${res.status})`);
    let parsed: z.infer<typeof accountReplySchema>;
    try {
      parsed = accountReplySchema.parse(JSON.parse(text));
    } catch {
      throw new ControlError("PROVIDER_UNAVAILABLE", "seller host returned an invalid account reply");
    }
    try {
      writeSecretFileOnce(path, `${parsed.token}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readSecretFile(path);
      if (existing === undefined) throw error;
      return existing;
    }
    return parsed.token;
  }
}
