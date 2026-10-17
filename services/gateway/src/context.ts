import type { KeyObject } from "node:crypto";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import type { FacilitatorSupport } from "@veilo/x402-client";
import type { GatewayChain } from "./chain";
import type { GatewayDb } from "./db/database";
import type { InferenceService } from "./inference";

/** Facilitator operations used by the gateway; HTTPFacilitatorClient satisfies it. */
export interface GatewayFacilitator {
  getSupported(): Promise<SupportedResponse>;
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

export interface GatewaySettings {
  identity: string;
  origin: string;
  network: string;
  mint: string;
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
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  hooks: GatewayHooks;
}
