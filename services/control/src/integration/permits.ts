import { createHash, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { loadUsagePermitPrivateKey, signUsagePermit, type GatewaySku } from "@veilo/contracts/gateway";

export const PERMIT_LIFETIME_SECONDS = 120;

/** Holds the usage-permit signing key in memory; the key is never logged or returned. */
export class PermitSigner {
  readonly #key: KeyObject;

  constructor(key: KeyObject) {
    this.#key = key;
  }

  static fromPem(pem: string): PermitSigner {
    return new PermitSigner(loadUsagePermitPrivateKey(pem));
  }

  static fromFile(path: string | undefined): PermitSigner | undefined {
    if (path === undefined || !existsSync(path)) return undefined;
    return PermitSigner.fromPem(readFileSync(path, "utf8"));
  }

  /** One permit per operation: the nonce is derived from the purchase so it is never reissued. */
  sign(p: {
    audience: string;
    purchaseId: string;
    operationId: string;
    accountId: string;
    sku: GatewaySku;
    units: bigint;
    requestDigest: string;
    workspaceId: string;
    agentId: string;
    taskId: string | null;
    nowMs: number;
  }): { permit: string; nonce: string; expiresAtMs: number } {
    const iat = Math.floor(p.nowMs / 1000);
    const exp = iat + PERMIT_LIFETIME_SECONDS;
    const nonce = `pmt_${p.purchaseId}`;
    // Opaque scope: lets the gateway group usage without learning workspace structure.
    const scope = `s_${createHash("sha256").update(`${p.workspaceId}:${p.agentId}:${p.taskId ?? ""}`).digest("hex").slice(0, 24)}`;
    const permit = signUsagePermit(
      {
        v: 1,
        typ: "usage-permit",
        aud: p.audience,
        nonce,
        accountId: p.accountId,
        sku: p.sku,
        units: p.units.toString(),
        requestDigest: p.requestDigest,
        operationId: p.operationId,
        scope,
        agentRef: p.agentId,
        ...(p.taskId ? { taskRef: p.taskId } : {}),
        iat,
        exp,
      },
      this.#key,
    );
    return { permit, nonce, expiresAtMs: exp * 1000 };
  }
}
