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
    adapterVersion: "1.0.0",
    upstream: "https://api.higgsfield.ai",
    tools: [
      {
        name: "generate_image",
        effect: "read_only",
        io: { inputs: [{ name: "prompt", kind: "text", required: true, maxChars: 2000 }], output: { kind: "image_url" } },
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
    adapterVersion: "1.0.0",
    upstream: "https://zernio.com/api/v1",
    tools: [
      {
        name: "create_draft",
        effect: "draft_external",
        io: { inputs: [{ name: "text", kind: "text", required: true, maxChars: 2000 }], output: { kind: "draft_post" } },
      },
    ],
  },
};

