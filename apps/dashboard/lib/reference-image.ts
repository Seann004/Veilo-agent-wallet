/** Formats control accepts for a task's reference image; SVG and GIF are refused there too. */
export const REFERENCE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const REFERENCE_IMAGE_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const REFERENCE_IMAGE_MAX_SIDE = 1280;
/** Control's decoded-size limit for the image it stores. */
const SERVER_MAX_BYTES = 1_572_864;

/** Why a chosen file cannot be used, or null when it can. */
export function referenceFileProblem(file: { type: string; size: number }): string | null {
  if (!(REFERENCE_IMAGE_TYPES as readonly string[]).includes(file.type)) return "Use a PNG, JPEG or WebP image.";
  if (file.size > REFERENCE_IMAGE_MAX_FILE_BYTES) return "That image is larger than 2 MB.";
  return null;
}

/** Width and height scaled so the longest side is at most `max`, never enlarged. */
export function fitWithin(width: number, height: number, max = REFERENCE_IMAGE_MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const decodedBytes = (dataUrl: string) => Math.floor(((dataUrl.length - dataUrl.indexOf(",") - 1) * 3) / 4);

/**
 * Re-encodes the image as JPEG on a canvas, at most 1280 px on its longest side, so the run request
 * stays small. Transparent areas become white. Lower quality is tried until it fits the server limit.
 */
export async function downscaleReferenceImage(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("This browser cannot resize images.");
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, width, height);
    g.drawImage(bitmap, 0, 0, width, height);
    for (const quality of [0.85, 0.7, 0.5]) {
      const url = canvas.toDataURL("image/jpeg", quality);
      if (!url.startsWith("data:image/jpeg;base64,")) throw new Error("This browser cannot resize images.");
      if (decodedBytes(url) <= SERVER_MAX_BYTES) return url;
    }
    throw new Error("That image is still too large after resizing.");
  } finally {
    bitmap.close();
  }
}
