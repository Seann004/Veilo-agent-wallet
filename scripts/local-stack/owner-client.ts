// Owner-side HTTP client for the control and wallet services: the same authenticated owner API
// the dashboard uses (signed session challenge, CSRF header). Deposits and exits are signed with
// the owner's key here and submitted by signature; nothing bypasses the services.
import { getBase64EncodedWireTransaction, getSignatureFromTransaction, partiallySignTransaction, type KeyPairSigner } from "@solana/kit";
import { decodeWireTransaction } from "@veilo/x402-client";
import { awaitTx, sendWire, sleep, type Rpc } from "../devnet/lib";

export interface Reply {
  status: number;
  // Service replies are checked field by field by callers.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export class OwnerClient {
  #cookie = "";
  #csrf = "";

  constructor(
    readonly controlUrl: string,
    readonly walletUrl: string,
    readonly origin: string,
  ) {}

  async #call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.#cookie ? { cookie: this.#cookie } : {}),
        ...(method !== "GET" && this.#csrf ? { "x-csrf-token": this.#csrf } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(300_000),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text.slice(0, 300) };
    }
    return { status: res.status, body: parsed };
  }

  control(method: string, path: string, body?: unknown): Promise<Reply> {
    return this.#call(this.controlUrl, method, path, body, method === "GET" ? {} : { origin: this.origin });
  }

  wallet(method: string, path: string, body?: unknown): Promise<Reply> {
    return this.#call(this.walletUrl, method, path, body);
  }

  /** Signs the control session challenge (an off-chain message, not a transaction). */
  async login(owner: string, signText: (message: string) => string): Promise<void> {
    const ch = await this.control("POST", "/session/challenge", { address: owner });
    if (ch.status !== 201) throw new Error(`session challenge failed: HTTP ${ch.status} ${JSON.stringify(ch.body)}`);
    const res = await fetch(`${this.controlUrl}/session/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: this.origin },
      body: JSON.stringify({ address: owner, nonce: ch.body.nonce, signature: signText(ch.body.message as string) }),
    });
    const body = (await res.json()) as { csrfToken?: string };
    const token = /veilo_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    if (res.status !== 200 || !token || !body.csrfToken) throw new Error(`session verify failed: HTTP ${res.status}`);
    this.#cookie = `veilo_session=${token}`;
    this.#csrf = body.csrfToken;
  }

  async workspace(): Promise<Reply["body"]> {
    const r = await this.control("GET", "/workspace");
    if (r.status !== 200) throw new Error(`GET /workspace: HTTP ${r.status}`);
    return r.body;
  }

  async agentId(name: "Shawn" | "Prince" | "Mira"): Promise<string> {
    const ws = await this.workspace();
    const a = (ws.agents as Array<{ id: string; name: string }>).find((x) => x.name === name);
    if (!a) throw new Error(`agent ${name} not found`);
    return a.id;
  }

  /** Creates and activates a workspace policy version. */
  async setWorkspacePolicy(policy: Record<string, unknown>): Promise<void> {
    const d = await this.control("POST", "/workspace/policy", { policy });
    if (d.status !== 201) throw new Error(`workspace policy draft: HTTP ${d.status} ${JSON.stringify(d.body)}`);
    const a = await this.control("POST", "/workspace/policy", { activateVersion: d.body.draft.version });
    if (a.status !== 200) throw new Error(`workspace policy activation: HTTP ${a.status} ${JSON.stringify(a.body)}`);
  }

  /** Creates and activates an agent policy version. */
  async setAgentPolicy(agentId: string, policy: Record<string, unknown>): Promise<void> {
    const d = await this.control("PATCH", `/agents/${agentId}/config`, { policy });
    if (d.status !== 200 || !d.body.draft) throw new Error(`agent policy draft: HTTP ${d.status} ${JSON.stringify(d.body)}`);
    const a = await this.control("PATCH", `/agents/${agentId}/config`, { activatePolicyVersion: d.body.draft.version });
    if (a.status !== 200) throw new Error(`agent policy activation: HTTP ${a.status} ${JSON.stringify(a.body)}`);
  }

  /** Activates the seeded draft policies (version 1) when they are still drafts. */
  async activateSeededPolicies(): Promise<void> {
    const ws = await this.workspace();
    const policies = ws.policies as Array<{ scope: string; agentId: string | null; version: number; status: string }>;
    for (const p of policies.filter((x) => x.status === "draft" && x.version === 1)) {
      const r = p.scope === "workspace"
        ? await this.control("POST", "/workspace/policy", { activateVersion: 1 })
        : await this.control("PATCH", `/agents/${p.agentId}/config`, { activatePolicyVersion: 1 });
      if (r.status !== 200) throw new Error(`activate ${p.scope} policy: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    }
  }

  async workerToken(agentId: string): Promise<string> {
    const r = await this.control("POST", `/agents/${agentId}/worker-credentials`, {});
    if (r.status !== 201) throw new Error(`worker credential: HTTP ${r.status}`);
    return r.body.token as string;
  }

  /** Owner deposit through the wallet API: prepare → owner signs → send → register → finalized. */
  async deposit(rpc: Rpc, owner: KeyPairSigner, amount: bigint, onSent?: (s: { depositId: string; signature: string }) => void): Promise<{ depositId: string; signature: string }> {
    const prep = await this.wallet("POST", "/deposits/prepare", { amount: amount.toString() });
    if (prep.status !== 201) throw new Error(`deposit prepare: HTTP ${prep.status} ${JSON.stringify(prep.body)}`);
    const signed = await signWire(prep.body.transaction as string, owner);
    const reg = await this.wallet("POST", "/deposits/register", { depositId: prep.body.depositId, signature: signed.signature });
    if (reg.status !== 200) throw new Error(`deposit register: HTTP ${reg.status} ${JSON.stringify(reg.body)}`);
    onSent?.({ depositId: prep.body.depositId as string, signature: signed.signature });
    await sendWire(rpc, signed.wire).catch(() => undefined);
    const r = await awaitTx(rpc, { signature: signed.signature, lastValidBlockHeight: prep.body.lastValidBlockHeight as string, sentAt: new Date().toISOString() });
    if (r.state !== "finalized" || r.outcome.err !== null) throw new Error(`deposit ${signed.signature}: ${r.state}`);
    return { depositId: prep.body.depositId as string, signature: signed.signature };
  }

  async notes(): Promise<Reply["body"]> {
    const r = await this.wallet("GET", "/notes/status");
    if (r.status !== 200) throw new Error(`notes status: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }

  /** Polls the wallet (which syncs against verified public state) until `pred` holds. */
  async waitNotes(pred: (status: Reply["body"]) => boolean, what: string, timeoutMs = 240_000): Promise<Reply["body"]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.notes().catch(() => null);
      if (s && pred(s)) return s;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(s?.totals ?? null)}`);
      await sleep(3_000);
    }
  }

  async purchase(id: string): Promise<Reply["body"]> {
    return (await this.control("GET", `/purchases/${id}`)).body;
  }

  async reconcile(id: string): Promise<Reply> {
    return this.control("POST", `/purchases/${id}/reconcile`, {});
  }
}

export async function signWire(wire: string, signer: KeyPairSigner): Promise<{ wire: string; signature: string }> {
  const tx = await partiallySignTransaction([signer.keyPair], decodeWireTransaction(wire));
  return { wire: getBase64EncodedWireTransaction(tx), signature: getSignatureFromTransaction(tx) };
}

/** Agent-scoped client using a worker credential (the same API the runner's tools call). */
export class WorkerClient {
  constructor(
    readonly controlUrl: string,
    readonly token: string,
  ) {}

  async call(method: string, path: string, body?: unknown): Promise<Reply> {
    const res = await fetch(`${this.controlUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(300_000),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  }
}
