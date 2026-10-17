/** Brand marks from Simple Icons (CC0, see NOTICE), drawn in each brand's colour. */
export interface Brand {
  name: string;
  logo: string;
  color: string;
}

export const BRANDS = {
  telegram: { name: "Telegram", logo: "/logos/telegram.svg", color: "#26A5E4" },
  slack: { name: "Slack", logo: "/logos/slack.svg", color: "#E01E5A" },
  discord: { name: "Discord", logo: "/logos/discord.svg", color: "#5865F2" },
  gmail: { name: "Gmail", logo: "/logos/gmail.svg", color: "#EA4335" },
  googledrive: { name: "Google Drive", logo: "/logos/googledrive.svg", color: "#4285F4" },
  googlecalendar: { name: "Google Calendar", logo: "/logos/googlecalendar.svg", color: "#4285F4" },
  notion: { name: "Notion", logo: "/logos/notion.svg", color: "currentColor" },
  github: { name: "GitHub", logo: "/logos/github.svg", color: "currentColor" },
  linear: { name: "Linear", logo: "/logos/linear.svg", color: "#5E6AD2" },
  figma: { name: "Figma", logo: "/logos/figma.svg", color: "#F24E1E" },
  hubspot: { name: "HubSpot", logo: "/logos/hubspot.svg", color: "#FF7A59" },
  canva: { name: "Canva", logo: "/logos/canva.svg", color: "#00C4CC" },
  solana: { name: "Solana", logo: "/logos/solana.svg", color: "#9945FF" },
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
