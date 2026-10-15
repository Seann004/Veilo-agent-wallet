/** Proof system used by every Veilo circuit. */
export const PROOF_SYSTEM = { curve: "bn254", protocol: "groth16" } as const;

export const PROTOCOL_VERSION = 1;
export const ENCODING_VERSION = "v1";

export * from "./field";
export * from "./poseidon";
export * from "./label";
export * from "./intent";
export * from "./note";
export * from "./tree";
export * from "./keys";
export * from "./pda";
export * from "./witness";
export * from "./proof";
export * from "./vectors";
