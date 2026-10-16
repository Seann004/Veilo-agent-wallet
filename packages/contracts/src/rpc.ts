import { createDefaultRpcTransport, createSolanaRpc, createSolanaRpcFromTransport, devnet } from "@solana/kit";

export type DevnetRpc = ReturnType<typeof createSolanaRpc>;

const RATE_LIMITED = /HTTP error \(429\)|Too Many Requests/;

// A 429 means the request was rejected unprocessed, so resending the same payload
// (including an already-signed transaction) cannot apply it twice.
export function createDevnetRpc(url: string, opts: { maxRetries?: number; maxDelayMs?: number } = {}): DevnetRpc {
  const maxRetries = opts.maxRetries ?? 8;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  const base = createDefaultRpcTransport({ url: devnet(url) });
  const retrying = async <T>(request: Parameters<typeof base>[0]): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await base<T>(request);
      } catch (error) {
        const rateLimited = RATE_LIMITED.test(String((error as Error)?.message ?? error));
        if (!rateLimited || attempt >= maxRetries) throw error;
        await new Promise((r) => setTimeout(r, Math.min(maxDelayMs, 1_000 * 2 ** attempt)));
      }
    }
  };
  return createSolanaRpcFromTransport(Object.assign(retrying, { "~cluster": "devnet" as const }) as typeof base) as DevnetRpc;
}
