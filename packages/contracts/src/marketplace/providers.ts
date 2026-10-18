import type { ToolManifest, ToolProvider } from "./workflows";

/**
 * Pinned provider tool manifests. A listing records the digest at review; the seller host refuses to
 * quote a listing whose digest differs from the manifest it runs, so an adapter change disables
 * the tool until it is reviewed again. Endpoints follow each provider's official API docs
 * (checked 2026-10-17); they have not been exercised against the live providers.
 */
export const PROVIDER_MANIFESTS: Readonly<Record<ToolProvider, ToolManifest>> = {
  higgsfield: {
    provider: "higgsfield",
    adapterVersion: "1.2.0",
    upstream: "https://api.higgsfield.ai",
    tools: [
      {
        name: "generate_image",
        effect: "read_only",
        io: { inputs: [{ name: "prompt", kind: "text", required: true, maxChars: 2000 }], output: { kind: "image_url" } },
      },
      {
        // Reads "Slide N:" lines (2 to 7, capped by the seller) and an optional "Caption:" line; outputs {"images", "caption"}.
        name: "generate_carousel_images",
        effect: "read_only",
        io: { inputs: [{ name: "slides", kind: "text", required: true, maxChars: 4000 }], output: { kind: "json" } },
      },
      {
        // Edits one https photo once per "Slide N:" line (2 to 3) with Marketing Studio Image;
        // outputs {"images": edits, "caption"}. The buyer's photo URL is never passed on.
        name: "edit_carousel_images",
        effect: "read_only",
        io: {
          inputs: [
            { name: "slides", kind: "text", required: true, maxChars: 4000 },
            { name: "photo", kind: "image_url", required: true, maxChars: 2048 },
          ],
          output: { kind: "json" },
        },
      },
    ],
  },
  makeugc: {
    provider: "makeugc",
    adapterVersion: "1.0.0",
    upstream: "https://app.makeugc.ai/api/platform",
    tools: [
      {
        name: "generate_ugc_video",
        effect: "read_only",
        io: { inputs: [{ name: "script", kind: "text", required: true, maxChars: 1500 }], output: { kind: "video_url" } },
      },
    ],
  },
  zernio: {
    provider: "zernio",
    adapterVersion: "1.1.0",
    upstream: "https://zernio.com/api/v1",
    tools: [
      {
        // Sends {"images", "caption"} to the seller's TikTok inbox as a photo draft; it is never published.
        name: "create_tiktok_carousel_draft",
        effect: "draft_external",
        io: { inputs: [{ name: "carousel", kind: "json", required: true, maxChars: 8000 }], output: { kind: "draft_post" } },
      },
    ],
  },
  slides: {
    provider: "slides",
    adapterVersion: "1.0.0",
    // Slides are rendered locally; only the finished PNGs are uploaded, through Zernio media storage.
    upstream: "https://zernio.com/api/v1",
    tools: [
      {
        // Renders a JSON slide plan ({"slides": [...], "caption"}, 2 to 7 slides) into 1080x1920 PNGs
        // from a fixed template and uploads them; outputs {"images": public URLs, "caption"}.
        name: "render_carousel_slides",
        effect: "read_only",
        io: { inputs: [{ name: "plan", kind: "text", required: true, maxChars: 12000 }], output: { kind: "json" } },
      },
    ],
  },
  zernio_publish: {
    provider: "zernio_publish",
    adapterVersion: "1.0.0",
    upstream: "https://zernio.com/api/v1",
    tools: [
      {
        // Publishes {"images", "caption"} publicly to the seller's TikTok account at once; no draft step.
        name: "publish_tiktok_carousel",
        effect: "publish_external",
        io: { inputs: [{ name: "carousel", kind: "json", required: true, maxChars: 8000 }], output: { kind: "draft_post" } },
      },
    ],
  },
};
