import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { FIXTURE_DATA_LABEL } from "@veilo/contracts/gateway";

const recordSchema = z.object({
  id: z.string(),
  tier: z.enum(["basic", "expanded"]),
  title: z.string(),
  summary: z.string(),
  findings: z.array(z.string()),
  published: z.string(),
});

const collectionSchema = z.object({
  collection: z.string(),
  label: z.literal(FIXTURE_DATA_LABEL),
  description: z.string(),
  license: z.literal("CC0-1.0"),
  author: z.string(),
  created: z.string(),
  records: z.array(recordSchema).min(1),
});

type Collection = z.infer<typeof collectionSchema>;

let cached: Collection | undefined;

function load(): Collection {
  if (!cached) {
    const path = fileURLToPath(new URL("../../fixtures/research/records.json", import.meta.url));
    cached = collectionSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  }
  return cached;
}

export interface DatasetDelivery {
  label: string;
  dataset: "basic" | "expanded";
  query: string;
  collection: string;
  description: string;
  records: Array<{
    id: string;
    title: string;
    summary: string;
    findings: string[];
    source: { url: string; publisher: string; license: string; published: string; label: string };
  }>;
}

/** Basic returns the basic tier; expanded returns every record. The query is echoed, not used to filter. */
export function deliverDataset(dataset: "basic" | "expanded", query: string): DatasetDelivery {
  const c = load();
  const records = c.records.filter((r) => dataset === "expanded" || r.tier === "basic");
  return {
    label: FIXTURE_DATA_LABEL,
    dataset,
    query,
    collection: c.collection,
    description: c.description,
    records: records.map((r) => ({
      id: r.id,
      title: r.title,
      summary: r.summary,
      findings: r.findings,
      source: {
        url: `fixture://${c.collection}/${r.id}`,
        publisher: `${c.author} (synthetic)`,
        license: c.license,
        published: r.published,
        label: FIXTURE_DATA_LABEL,
      },
    })),
  };
}
