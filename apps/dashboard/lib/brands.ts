/** Official full-colour brand marks (sources in NOTICE). `logoDark` is the variant for dark themes. */
export interface Brand {
  name: string;
  logo: string;
  logoDark?: string;
}

export const BRANDS = {
  telegram: { name: "Telegram", logo: "/logos/telegram.svg" },
  slack: { name: "Slack", logo: "/logos/slack.svg" },
  discord: { name: "Discord", logo: "/logos/discord.svg" },
  gmail: { name: "Gmail", logo: "/logos/gmail.svg" },
  googledrive: { name: "Google Drive", logo: "/logos/googledrive.svg" },
  googlecalendar: { name: "Google Calendar", logo: "/logos/googlecalendar.svg" },
  notion: { name: "Notion", logo: "/logos/notion.svg" },
  github: { name: "GitHub", logo: "/logos/github-light.svg", logoDark: "/logos/github.svg" },
  linear: { name: "Linear", logo: "/logos/linear.svg" },
  figma: { name: "Figma", logo: "/logos/figma.svg" },
  hubspot: { name: "HubSpot", logo: "/logos/hubspot.png" },
  canva: { name: "Canva", logo: "/logos/canva.svg" },
  solana: { name: "Solana", logo: "/logos/solana.svg" },
  coingecko: { name: "CoinGecko", logo: "/logos/coingecko.png" },
  meteora: { name: "Meteora", logo: "/logos/meteora.png" },
} satisfies Record<string, Brand>;

export type BrandId = keyof typeof BRANDS;

/** A known brand for an MCP connector, matched on its id or host; unknown ones keep a monogram. */
export function brandForConnector(c: { id: string; endpoint?: string | undefined }): Brand | null {
  const text = `${c.id} ${c.endpoint ?? ""}`.toLowerCase();
  const hit = (Object.keys(BRANDS) as BrandId[]).find((k) => text.includes(k));
  return hit ? BRANDS[hit] : null;
}

/** Popular apps that need an OAuth sign-in, which Veilo does not support yet. Shown as such, never as usable. */
export const NEEDS_SIGN_IN: Array<{ id: BrandId; summary: string }> = [
  { id: "gmail", summary: "Read threads and draft replies" },
  { id: "googledrive", summary: "Search and read your files" },
  { id: "googlecalendar", summary: "Check and plan your schedule" },
  { id: "notion", summary: "Search and update your pages" },
  { id: "github", summary: "Read repositories, issues and pull requests" },
  { id: "linear", summary: "Read and file issues" },
  { id: "figma", summary: "Read designs and comments" },
  { id: "hubspot", summary: "CRM context for your agents" },
  { id: "canva", summary: "Find and export your designs" },
];
