import { HTTPFacilitatorClient } from "@x402/core/http";
import type { SupportedResponse } from "@x402/core/types";
import { DEVNET_CAIP2, isMainnetIdentifier } from "@veilo/contracts";

export interface FacilitatorSupportRequirement {
  network: string;
  mint: string;
  /** When set, the facilitator must advertise this exact fee payer for the network. */
  feePayer?: string;
}

export type FacilitatorSupport =
  | {
      supported: true;
      network: string;
      feePayers: string[];
      /**
       * `advertised`: the exact kind lists the mint. `unrestricted`: the exact kind names no
       * asset restriction, so any SPL mint is accepted by the advertised scheme.
       */
      mintEvidence: "advertised" | "unrestricted";
      checkedAt: string;
    }
  | { supported: false; reason: string; checkedAt: string };

function assetsOf(extra: Record<string, unknown> | undefined): string[] | undefined {
  if (!extra) return undefined;
  const list: string[] = [];
  if (typeof extra.asset === "string") list.push(extra.asset);
  if (Array.isArray(extra.assets)) for (const a of extra.assets) if (typeof a === "string") list.push(a);
  return list.length > 0 ? list : undefined;
}

/**
 * Fails closed unless the facilitator advertises x402 v2 `exact` on the devnet CAIP-2
 * network for the configured mint (and fee payer, when pinned).
 */
export function checkFacilitatorSupport(
  supported: SupportedResponse,
  requirement: FacilitatorSupportRequirement,
  now: Date = new Date(),
): FacilitatorSupport {
  const checkedAt = now.toISOString();
  if (requirement.network !== DEVNET_CAIP2 || isMainnetIdentifier(requirement.network)) {
    return { supported: false, reason: "required network is not devnet", checkedAt };
  }
  if (!supported || !Array.isArray(supported.kinds)) {
    return { supported: false, reason: "malformed /supported response", checkedAt };
  }
  const kinds = supported.kinds.filter(
    (k) => k.x402Version === 2 && k.scheme === "exact" && k.network === requirement.network,
  );
  if (kinds.length === 0) {
    return { supported: false, reason: "no x402 v2 exact kind for the devnet network", checkedAt };
  }
  const feePayers = [
    ...new Set(kinds.map((k) => k.extra?.feePayer).filter((f): f is string => typeof f === "string")),
  ];
  if (feePayers.length === 0) return { supported: false, reason: "exact kind advertises no fee payer", checkedAt };
  if (requirement.feePayer !== undefined && !feePayers.includes(requirement.feePayer)) {
    return { supported: false, reason: "configured fee payer is not advertised for devnet exact", checkedAt };
  }
  const restricted = kinds.map((k) => assetsOf(k.extra)).filter((a): a is string[] => a !== undefined);
  let mintEvidence: "advertised" | "unrestricted" = "unrestricted";
  if (restricted.length > 0) {
    if (!restricted.some((list) => list.includes(requirement.mint))) {
      return { supported: false, reason: "devnet exact kind does not list the configured mint", checkedAt };
    }
    mintEvidence = "advertised";
  }
  return { supported: true, network: requirement.network, feePayers, mintEvidence, checkedAt };
}

/** Read-only GET {url}/supported through the protocol facilitator client. */
export async function fetchFacilitatorSupported(url: string, timeoutMs = 15_000): Promise<SupportedResponse> {
  return new HTTPFacilitatorClient({ url, timeoutMs }).getSupported();
}
