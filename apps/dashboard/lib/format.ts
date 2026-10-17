/** Integer-only formatting of base-unit decimal strings; amounts never pass through floats. */
export function formatBaseUnits(amount: string | null | undefined, decimals: number): string {
  if (amount === null || amount === undefined || !/^(0|[1-9][0-9]*)$/.test(amount)) return "—";
  const v = BigInt(amount);
  const scale = 10n ** BigInt(decimals);
  const whole = v / scale;
  const frac = (v % scale).toString().padStart(decimals, "0");
  return `${groupDigits(whole.toString())}.${frac}`;
}

export function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export const usdc = (amount: string | null | undefined): string => {
  const f = formatBaseUnits(amount, 6);
  return f === "—" ? f : `${f} USDC`;
};

export const credits = (units: string | null | undefined): string =>
  units === null || units === undefined || !/^(0|[1-9][0-9]*)$/.test(units) ? "—" : `${groupDigits(units)} microcredits`;

export const lamports = (v: string | null | undefined): string =>
  v === null || v === undefined || !/^(0|[1-9][0-9]*)$/.test(v) ? "—" : `${groupDigits(v)} lamports`;

export function minBase(...values: Array<string | null | undefined>): string | null {
  let best: bigint | null = null;
  for (const v of values) {
    if (v === null || v === undefined || !/^(0|[1-9][0-9]*)$/.test(v)) return null;
    const b = BigInt(v);
    if (best === null || b < best) best = b;
  }
  return best === null ? null : best.toString();
}

export function sumBase(...values: Array<string | null | undefined>): string {
  let total = 0n;
  for (const v of values) if (v && /^(0|[1-9][0-9]*)$/.test(v)) total += BigInt(v);
  return total.toString();
}

/** Parses an owner-entered USDC amount ("1.5") into base units without floats. */
export function parseUsdcInput(text: string): string | null {
  const m = /^\s*(\d{1,12})(?:\.(\d{1,6}))?\s*$/.exec(text);
  if (!m) return null;
  const whole = BigInt(m[1]!);
  const frac = BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  return (whole * 1_000_000n + frac).toString();
}

export function shortKey(v: string | null | undefined, keep = 4): string {
  if (!v) return "—";
  return v.length <= keep * 2 + 1 ? v : `${v.slice(0, keep)}…${v.slice(-keep)}`;
}

export function when(isoTime: string | null | undefined, timeZone = "Asia/Kuala_Lumpur"): string {
  if (!isoTime) return "—";
  const d = new Date(isoTime);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(d);
}

export const explorerTx = (signature: string): string => `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
export const explorerAddress = (address: string): string => `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=devnet`;
