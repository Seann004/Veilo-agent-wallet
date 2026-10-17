// Self-hosted x402 facilitator for the local test validator: the official @x402/core facilitator
// with the @x402/svm `exact` scheme, signing as fee payer with a local throwaway key and
// submitting to the loopback validator. It serves the standard HTTP facilitator API
// (GET /supported, POST /verify, POST /settle) that the gateway's HTTPFacilitatorClient calls.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { registerExactSvmScheme } from "@x402/svm/exact/facilitator";
import { DEVNET_CAIP2 } from "@veilo/contracts";
import { loadSigner } from "../devnet/lib";
import { assertLoopback } from "./chain";

export interface LocalFacilitator {
  url: string;
  feePayer: string;
  calls: { verify: number; settle: number };
  close(): Promise<void>;
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export async function startLocalFacilitator(o: { rpcUrl: string; feePayerKeyPath: string; port: number }): Promise<LocalFacilitator> {
  assertLoopback(o.rpcUrl);
  const signer = await loadSigner(o.feePayerKeyPath);
  const facilitator = new x402Facilitator();
  registerExactSvmScheme(facilitator, { signer: toFacilitatorSvmSigner(signer, { defaultRpcUrl: o.rpcUrl }), networks: DEVNET_CAIP2 });
  const calls = { verify: 0, settle: 0 };
  const server: Server = createServer((req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
    };
    void (async () => {
      try {
        if (req.method === "GET" && req.url === "/supported") return send(200, facilitator.getSupported());
        if (req.method === "POST" && (req.url === "/verify" || req.url === "/settle")) {
          const b = (await body(req)) as { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };
          if (req.url === "/verify") {
            calls.verify += 1;
            return send(200, await facilitator.verify(b.paymentPayload, b.paymentRequirements));
          }
          calls.settle += 1;
          return send(200, await facilitator.settle(b.paymentPayload, b.paymentRequirements));
        }
        send(404, { error: "not found" });
      } catch (error) {
        send(500, { error: (error as Error).message.slice(0, 300) });
      }
    })();
  });
  await new Promise<void>((r) => server.listen(o.port, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    feePayer: signer.address,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
