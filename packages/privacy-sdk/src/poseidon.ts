import { buildPoseidon, type PoseidonFn } from "circomlibjs";
import { assertFieldElement } from "./field";

/** circomlib Poseidon over BN254 for the two arities used by the protocol. */
export interface Poseidon {
  h2(a: bigint, b: bigint): bigint;
  h3(a: bigint, b: bigint, c: bigint): bigint;
}

let instance: Promise<Poseidon> | undefined;

function wrap(fn: PoseidonFn): Poseidon {
  // circomlibjs reduces inputs modulo r silently; non-canonical inputs must fail instead.
  const hash = (inputs: bigint[]): bigint => {
    inputs.forEach((x, i) => assertFieldElement(x, `Poseidon input ${i}`));
    return fn.F.toObject(fn(inputs));
  };
  return {
    h2: (a, b) => hash([a, b]),
    h3: (a, b, c) => hash([a, b, c]),
  };
}

export function getPoseidon(): Promise<Poseidon> {
  instance ??= buildPoseidon().then(wrap);
  return instance;
}
