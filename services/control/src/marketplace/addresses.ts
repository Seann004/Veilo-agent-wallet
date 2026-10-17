import { isIP } from "node:net";
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";

const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** Associated token account of `owner` for `mint` under the original SPL Token program. */
export async function deriveAta(owner: string, mint: string): Promise<string> {
  const enc = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [enc.encode(address(owner)), enc.encode(TOKEN_PROGRAM), enc.encode(address(mint))],
  });
  return ata;
}

function ipv4Private(ip: string): boolean {
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** Parses an IPv6 literal (with `::` and an optional dotted IPv4 tail) into 16 bytes, or null. */
export function ipv6Bytes(input: string): Uint8Array | null {
  const ip = input.split("%")[0] ?? "";
  if (isIP(ip) !== 6) return null;
  let head = ip;
  const tail: number[] = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (v4?.[1]) {
    tail.push(...v4[1].split(".").map(Number));
    head = ip.slice(0, -v4[1].length);
    if (head.endsWith(":") && !head.endsWith("::")) head = head.slice(0, -1);
  }
  const groups = (part: string) => (part === "" ? [] : part.split(":").map((g) => parseInt(g, 16)));
  const [left = "", right] = head.split("::");
  const l = groups(left);
  const r = right === undefined ? [] : groups(right);
  const groupCount = 8 - tail.length / 2;
  const fill = right === undefined ? 0 : groupCount - l.length - r.length;
  if (fill < 0 || (right === undefined && l.length !== groupCount)) return null;
  const words = [...l, ...new Array<number>(fill).fill(0), ...r];
  const out = new Uint8Array(16);
  words.forEach((w, i) => {
    out[i * 2] = (w >> 8) & 0xff;
    out[i * 2 + 1] = w & 0xff;
  });
  tail.forEach((byte, i) => (out[12 + i] = byte));
  return out;
}

const v4At = (b: Uint8Array, i: number) => `${b[i]}.${b[i + 1]}.${b[i + 2]}.${b[i + 3]}`;

/**
 * True for loopback, private, link-local (including cloud metadata), CGNAT, documentation,
 * multicast and reserved ranges, for any IPv6 form that embeds such an IPv4 address (mapped,
 * compatible, NAT64, 6to4), for Teredo, and for anything that is not an IP literal. IPv6 is
 * classified numerically so textual variants cannot slip past.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return ipv4Private(ip);
  const b = ipv6Bytes(ip);
  if (!b) return true;
  const zeroUpTo = (n: number) => b.subarray(0, n).every((x) => x === 0);
  if (zeroUpTo(15) && (b[15] === 0 || b[15] === 1)) return true;
  if (zeroUpTo(10) && b[10] === 0xff && b[11] === 0xff) return ipv4Private(v4At(b, 12));
  if (zeroUpTo(12)) return ipv4Private(v4At(b, 12));
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true;
  if (b[0] === 0x20 && b[1] === 0x02) return ipv4Private(v4At(b, 2));
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true;
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;
  if (b[0] === 0x01 && b.subarray(1, 8).every((x) => x === 0)) return true;
  const first = b[0] ?? 0;
  const second = b[1] ?? 0;
  return (first & 0xfe) === 0xfc || (first === 0xfe && (second & 0xc0) === 0x80) || first === 0xff;
}
