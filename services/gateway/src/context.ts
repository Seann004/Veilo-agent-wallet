import type { KeyObject } from "node:crypto";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import type { FacilitatorSupport } from "@veilo/x402-client";
import type { GatewayChain } from "./chain";
import type { GatewayDb } from "./db/database";
import type { InferenceService } from "./inference";
import type { MarketplaceClient } from "./seller-host/marketplace-client";

/** Facilitator operations used by the gateway; HTTPFacilitatorClient satisfies it. */
export interface GatewayFacilitator {
  getSupported(): Promise<SupportedResponse>;
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

export type GatewayRole = "operator" | "seller-host";

export interface SellerHostSettings {
  /** When non-empty, only these payout owners may be named as a quote recipient. */
  allowedRecipients: readonly string[];
  heartbeatMs: number;
  /** Delays between claim attempts while the marketplace has not queued the job yet. */
  claimRetryDelaysMs: readonly number[];
}

export interface GatewaySettings {
  /** `operator` sells the fixed catalog to the operator's merchant; `seller-host` sells only marketplace specialist jobs. */
  role: GatewayRole;
  identity: string;
  origin: string;
  network: string;
  genesisHash: string;
  mint: string;
  mintDecimals: number;
  facilitatorUrl: string;
  merchantAddress: string | undefined;
  merchantAta: string | undefined;
  feePayer: string | undefined;
  quoteTtlSeconds: number;
  settlementWaitMs: number;
  /** Poll interval while waiting for finality inside one request. */
  settlementPollMs: number;
  maxTimeoutSeconds: number;
  operatorCeilingMicro: bigint;
  sellerHost: SellerHostSettings | undefined;
}

/** Test-only fault injection points. Production wiring leaves these undefined. */
export interface GatewayHooks {
  afterClaim?: () => void;
  afterPaymentFinalized?: () => void;
  beforeProviderCall?: () => void;
}

export interface AcceptanceState {
  ready: boolean;
  reason: string | undefined;
  support: FacilitatorSupport | undefined;
  merchantAta: string | undefined;
  feePayer: string | undefined;
}

export interface GatewayContext {
  db: GatewayDb;
  settings: GatewaySettings;
  chain: GatewayChain;
  facilitator: GatewayFacilitator;
  inference: InferenceService;
  permitPublicKey: KeyObject | undefined;
  planningTokenHash: string | undefined;
  acceptance: AcceptanceState;
  /** Present only in the seller-host role. */
  marketplace: MarketplaceClient | undefined;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  hooks: GatewayHooks;
}
