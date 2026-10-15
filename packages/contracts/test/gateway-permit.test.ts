import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  computeRequestDigest,
  generateUsagePermitKeyPair,
  loadUsagePermitPrivateKey,
  loadUsagePermitPublicKey,
  signUsagePermit,
  UsagePermitError,
  verifyUsagePermit,
  type UsagePermitPayload,
} from "../src/gateway";

const pair = generateUsagePermitKeyPair();
const priv = loadUsagePermitPrivateKey(pair.privateKeyPem);
const pub = loadUsagePermitPublicKey(pair.publicKeyPem);

const payload: UsagePermitPayload = {
  v: 1,
  typ: "usage-permit",
  aud: "veilo-gateway-devnet",
  nonce: "nonce-1",
  accountId: "acct_1",
  sku: "summarize",
  units: "100000",
  requestDigest: computeRequestDigest("summarize", { text: "hi" }),
  operationId: "op-1",
  scope: "agent:a/task:t",
  iat: 1_000,
  exp: 1_120,
};

const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as UsagePermitError).reason;
  }
  return "accepted";
};

describe("usage permit v1", () => {
  it("round-trips and binds every field", () => {
    const token = signUsagePermit(payload, priv);
    expect(token.startsWith("vup1.")).toBe(true);
    expect(verifyUsagePermit(token, { publicKey: pub, audience: "veilo-gateway-devnet", nowSeconds: 1_010 })).toEqual(payload);
  });

  it("rejects tampering, wrong key, audience, expiry and long lifetimes", () => {
    const token = signUsagePermit(payload, priv);
    const [p, b, s] = token.split(".");
    const altered = Buffer.from(b!, "base64url").toString("utf8").replace('"units":"100000"', '"units":"100001"');
    expect(reason(() => verifyUsagePermit(`${p}.${Buffer.from(altered).toString("base64url")}.${s}`, { publicKey: pub, audience: "veilo-gateway-devnet", nowSeconds: 1_010 }))).toBe("bad_signature");
    const other = loadUsagePermitPublicKey(generateUsagePermitKeyPair().publicKeyPem);
    expect(reason(() => verifyUsagePermit(token, { publicKey: other, audience: "veilo-gateway-devnet", nowSeconds: 1_010 }))).toBe("bad_signature");
    expect(reason(() => verifyUsagePermit(token, { publicKey: pub, audience: "other", nowSeconds: 1_010 }))).toBe("wrong_audience");
    expect(reason(() => verifyUsagePermit(token, { publicKey: pub, audience: "veilo-gateway-devnet", nowSeconds: 1_120 }))).toBe("expired");
    expect(reason(() => signUsagePermit({ ...payload, exp: payload.iat + 301 }, priv))).toBe("lifetime_too_long");
  });

  it("request digests are canonical over key order", () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
    expect(computeRequestDigest("analyze", { text: "x", question: "q" })).toBe(computeRequestDigest("analyze", { question: "q", text: "x" }));
    expect(computeRequestDigest("analyze", { text: "x" })).not.toBe(computeRequestDigest("summarize", { text: "x" }));
  });
});
