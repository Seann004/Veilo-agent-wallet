import { z } from "zod";
import type { InferenceSku } from "./catalog";

export interface PromptMessage {
  role: "system" | "user";
  content: string;
}

type Input = Record<string, unknown>;

export function buildMessages(sku: InferenceSku, input: Input): PromptMessage[] {
  switch (sku) {
    case "summarize":
      return [
        {
          role: "system",
          content:
            "Summarize the user's text faithfully in plain prose, at most 200 words. Do not add facts that are not in the text. If the text is unclear, say so.",
        },
        { role: "user", content: String(input.text) },
      ];
    case "analyze":
      return [
        {
          role: "system",
          content:
            "Analyze the user's text. Answer the question if one is given, otherwise list the key claims, the evidence offered for each, and open questions. Mark anything uncertain as uncertain. Do not invent sources.",
        },
        {
          role: "user",
          content: `${input.question === undefined ? "" : `Question: ${String(input.question)}\n\n`}Text:\n${String(input.text)}`,
        },
      ];
    case "content-package": {
      const channels = (input.channels as string[]).join(", ");
      return [
        {
          role: "system",
          content: [
            "You draft marketing content for review by a human editor. Nothing is published automatically.",
            "Return only a JSON object with this exact shape:",
            '{"drafts":[{"channel":string,"title":string,"body":string}, x3],',
            ' "calendar":[{"day":1..7,"channel":string,"draftIndex":0|1|2|null,"action":string}, x7]}',
            "Write exactly one draft per requested channel, in the requested order.",
            "The calendar has exactly seven entries, one for each day 1 through 7.",
            "Do not invent statistics, quotes or sources.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Topic: ${String(input.topic)}`,
            `Audience: ${String(input.audience)}`,
            `Channels: ${channels}`,
            `Voice: ${String(input.voice)}`,
            input.startDate === undefined ? "" : `Calendar starts: ${String(input.startDate)}`,
            input.brief === undefined ? "" : `Brief and research notes:\n${String(input.brief)}`,
          ]
            .filter((l) => l !== "")
            .join("\n"),
        },
      ];
    }
  }
}

export const contentPackageSchema = z
  .object({
    drafts: z
      .array(
        z.object({
          channel: z.string().min(1).max(60),
          title: z.string().min(1).max(200),
          body: z.string().min(1).max(4_000),
        }),
      )
      .length(3),
    calendar: z
      .array(
        z.object({
          day: z.number().int().min(1).max(7),
          channel: z.string().min(1).max(60),
          draftIndex: z.number().int().min(0).max(2).nullable(),
          action: z.string().min(1).max(500),
        }),
      )
      .length(7),
  })
  .superRefine((value, ctx) => {
    const days = new Set(value.calendar.map((c) => c.day));
    if (days.size !== 7) ctx.addIssue({ code: "custom", message: "calendar must cover days 1-7 exactly once" });
  });
export type ContentPackage = z.infer<typeof contentPackageSchema>;

export type ContentValidation =
  | { valid: true; content: ContentPackage }
  | { valid: false; issues: string[] };

export function validateContentPackage(text: string, channels: readonly string[]): ContentValidation {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { valid: false, issues: ["output is not JSON"] };
  }
  const parsed = contentPackageSchema.safeParse(raw);
  if (!parsed.success) {
    return { valid: false, issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).slice(0, 20) };
  }
  const draftChannels = parsed.data.drafts.map((d) => d.channel.toLowerCase());
  if (draftChannels.join("|") !== channels.map((c) => c.toLowerCase()).join("|")) {
    return { valid: false, issues: ["drafts do not match the requested channels in order"] };
  }
  return { valid: true, content: parsed.data };
}
