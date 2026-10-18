import type { Ledger } from "../context";
import { ControlError } from "../errors";

export const REFERENCE_IMAGE_MAX_BYTES = 1_572_864;
export type ReferenceImageMime = "image/png" | "image/jpeg" | "image/webp";

export interface ReferenceImage {
  mime: ReferenceImageMime;
  bytes: Buffer;
}

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/;
const MAX_DATA_URL_CHARS = "data:image/jpeg;base64,".length + Math.ceil(REFERENCE_IMAGE_MAX_BYTES / 3) * 4;

function magicMatches(mime: ReferenceImageMime, b: Buffer): boolean {
  if (mime === "image/png") return b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === "image/jpeg") return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  return b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP";
}

/**
 * Accepts only a base64 data URL of a PNG, JPEG or WebP whose first bytes match its declared type
 * and whose decoded size is within the limit. SVG, GIF and remote URLs are refused.
 */
export function parseReferenceImage(value: unknown): ReferenceImage {
  const bad = (why: string): never => {
    throw new ControlError("INVALID_REQUEST", `input.referenceImage: ${why}`);
  };
  if (typeof value !== "string") return bad("must be a data URL");
  if (value.length > MAX_DATA_URL_CHARS) return bad("image is larger than 1.5 MB");
  const m = DATA_URL.exec(value);
  if (!m) return bad("must be a base64 data URL of a PNG, JPEG or WebP image");
  const b64 = m[2] as string;
  if (b64.length === 0 || b64.length % 4 !== 0) return bad("base64 data is malformed");
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length > REFERENCE_IMAGE_MAX_BYTES) return bad("image is larger than 1.5 MB");
  const mime = m[1] as ReferenceImageMime;
  if (!magicMatches(mime, bytes)) return bad(`file content is not a ${mime.slice(6).toUpperCase()} image`);
  return { mime, bytes };
}

export function saveReferenceImage(ledger: Ledger, taskId: string, image: ReferenceImage): void {
  ledger.db
    .prepare(`INSERT INTO task_attachment (task_id, kind, mime, bytes, created_at_ms) VALUES (?, 'reference_image', ?, ?, ?)`)
    .run(taskId, image.mime, image.bytes, ledger.now());
}

export function loadReferenceImage(ledger: Ledger, taskId: string): ReferenceImage | undefined {
  const row = ledger.db.prepare(`SELECT mime, bytes FROM task_attachment WHERE task_id = ? AND kind = 'reference_image'`).get(taskId) as
    | { mime: ReferenceImageMime; bytes: Buffer }
    | undefined;
  return row ? { mime: row.mime, bytes: Buffer.from(row.bytes) } : undefined;
}
