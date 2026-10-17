/** A random key accepted by the marketplace (`[A-Za-z0-9._:-]{8,128}`). */
export function newIdempotencyKey(prefix = "hire"): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * One key per logical submission. Retrying the same content after an error or a lost reply
 * reuses the key, so the server returns the job it already created; changed content gets a
 * fresh key because the server refuses a reused key with different content.
 */
export class SubmissionKey {
  #current: { fingerprint: string; key: string } | null = null;

  constructor(private readonly generate: () => string = () => newIdempotencyKey()) {}

  keyFor(fingerprint: string): string {
    if (this.#current?.fingerprint !== fingerprint) this.#current = { fingerprint, key: this.generate() };
    return this.#current.key;
  }

  /** Call after the server has confirmed the submission so the next one starts fresh. */
  settle(): void {
    this.#current = null;
  }
}
