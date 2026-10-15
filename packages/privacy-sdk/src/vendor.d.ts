// Minimal typings for the untyped JavaScript dependencies used by this package.

declare module "circomlibjs" {
  export interface PoseidonField {
    toObject(element: Uint8Array): bigint;
  }
  export interface PoseidonFn {
    (inputs: bigint[]): Uint8Array;
    F: PoseidonField;
  }
  export function buildPoseidon(): Promise<PoseidonFn>;
}

declare module "snarkjs" {
  export type NumericString = string;
  export interface Groth16Proof {
    pi_a: NumericString[];
    pi_b: NumericString[][];
    pi_c: NumericString[];
    protocol: string;
    curve: string;
  }
  export interface VerificationKey {
    protocol: string;
    curve: string;
    nPublic: number;
    vk_alpha_1: NumericString[];
    vk_beta_2: NumericString[][];
    vk_gamma_2: NumericString[][];
    vk_delta_2: NumericString[][];
    IC: NumericString[][];
    [key: string]: unknown;
  }
  export type SignalValue = string | bigint | number | SignalValue[];
  export type CircuitInputs = Record<string, SignalValue>;
  type FileLike = string | Uint8Array | { type: "mem"; data?: Uint8Array };
  interface Logger {
    debug(msg: string): void;
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  }
  export const groth16: {
    fullProve(
      input: CircuitInputs,
      wasm: FileLike,
      zkey: FileLike,
      logger?: Logger,
    ): Promise<{ proof: Groth16Proof; publicSignals: NumericString[] }>;
    verify(vk: VerificationKey, publicSignals: NumericString[], proof: Groth16Proof, logger?: Logger): Promise<boolean>;
  };
  export const powersOfTau: {
    newAccumulator(curve: unknown, power: number, fileName: string, logger?: Logger): Promise<unknown>;
    beacon(
      oldPtau: string,
      newPtau: string,
      name: string,
      beaconHashHex: string,
      numIterationsExp: number,
      logger?: Logger,
    ): Promise<unknown>;
    contribute(oldPtau: string, newPtau: string, name: string, entropy: string, logger?: Logger): Promise<unknown>;
    preparePhase2(oldPtau: string, newPtau: string, logger?: Logger): Promise<unknown>;
    verify(ptau: string, logger?: Logger): Promise<boolean>;
  };
  export const zKey: {
    newZKey(r1cs: string, ptau: string, zkey: string, logger?: Logger): Promise<unknown>;
    beacon(
      oldZkey: string,
      newZkey: string,
      name: string,
      beaconHashHex: string,
      numIterationsExp: number,
      logger?: Logger,
    ): Promise<unknown>;
    contribute(oldZkey: string, newZkey: string, name: string, entropy: string, logger?: Logger): Promise<unknown>;
    exportVerificationKey(zkey: FileLike, logger?: Logger): Promise<VerificationKey>;
    verifyFromR1cs(r1cs: string, ptau: string, zkey: string, logger?: Logger): Promise<boolean>;
  };
  export const wtns: {
    calculate(input: CircuitInputs, wasm: FileLike, wtns: FileLike): Promise<void>;
    exportJson(wtns: FileLike): Promise<bigint[]>;
    check(r1cs: string, wtns: FileLike, logger?: Logger): Promise<boolean>;
  };
  export const r1cs: {
    info(r1cs: string, logger?: Logger): Promise<{
      nConstraints: number;
      nPubInputs: number;
      nPrvInputs: number;
      nOutputs: number;
      nVars: number;
      nLabels: number;
    }>;
  };
  export const curves: {
    getCurveFromName(name: string): Promise<{ terminate(): Promise<void> }>;
  };
}
