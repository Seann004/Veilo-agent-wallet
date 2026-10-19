export type EvidenceNetwork = "devnet" | "local-validator" | "unknown";
export interface EvidenceSignature {
  signature: string;
  where: string;
  network: EvidenceNetwork;
  explorer: string | null;
}

/** Local or ambiguous evidence must never acquire a public-devnet receipt link. */
export function evidenceNetwork(value: unknown, source: string): EvidenceNetwork {
  const v = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const environment = JSON.stringify(v.environment ?? "");
  const network = typeof v.network === "string" ? v.network : "";
  const labels = `${environment} ${network}`;
  if (/(^|\/)integration-[^/]*\.json$/.test(source) || /local[ -]test[ -]validator|solana-test-validator|not devnet|local-rehearsal/i.test(labels) || (v.profile === "local" || v.profile === "local-rehearsal")) return "local-validator";
  if (v.profile === "devnet" || /\bdevnet\b/i.test(labels) || network === "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1") return "devnet";
  return "unknown";
}

export function evidenceSignatures(value: unknown, source: string): EvidenceSignature[] {
  const network = evidenceNetwork(value, source);
  const found: EvidenceSignature[] = [];
  const visit = (v: unknown, where: string): void => {
    if (typeof v === "string") {
      if (/^[1-9A-HJ-NP-Za-km-z]{86,90}$/.test(v)) found.push({ signature: v, where, network, explorer: network === "devnet" ? `https://explorer.solana.com/tx/${v}?cluster=devnet` : null });
    } else if (Array.isArray(v)) v.forEach((item, i) => visit(item, `${where}[${i}]`));
    else if (v && typeof v === "object") for (const [k, item] of Object.entries(v)) visit(item, `${where}.${k}`);
  };
  visit(value, source);
  return found;
}
