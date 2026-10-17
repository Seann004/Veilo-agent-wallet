import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db";
import { MarketError } from "../src/errors";
import { completeJob, type Deps } from "../src/service";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

type RpcMode = "commit" | "commit_reply_lost" | "reject";

/** Storage plus the two tables completion reads, with an mk_complete that can lose its reply. */
function fakeDeps(mode: { rpc: RpcMode; readFails?: boolean }) {
  const objects = new Map<string, Buffer>();
  const removed: string[] = [];
  const artifacts: Array<{ job_id: string; attempt_id: string; bucket: string; object_key: string; sha256: string }> = [];
  const jobs = new Map<string, string>();
  const query = (table: string) => {
    const filters: Record<string, string> = {};
    const result = () => {
      if (mode.readFails) return { data: null, error: { message: "timeout" } };
      if (table === "jobs") return { data: jobs.has(filters.id!) ? { state: jobs.get(filters.id!) } : null, error: null };
      return { data: artifacts.filter((r) => Object.entries(filters).every(([k, v]) => r[k as keyof typeof r] === v)), error: null };
    };
    const q = {
      select: () => q,
      eq: (k: string, v: string) => ((filters[k] = v), q),
      maybeSingle: async () => result(),
      then: (resolve: (v: unknown) => void) => resolve(result()),
    };
    return q;
  };
  const storage = {
    from: () => ({
      upload: async (key: string, bytes: Buffer) => {
        if (objects.has(key)) return { error: { message: "The resource already exists", statusCode: "409" } };
        objects.set(key, Buffer.from(bytes));
        return { error: null };
      },
      download: async (key: string) => {
        const b = objects.get(key);
        return b ? { data: new Blob([b]), error: null } : { data: null, error: { message: "not found" } };
      },
      remove: async (keys: string[]) => {
        for (const k of keys) {
          objects.delete(k);
          removed.push(k);
        }
        return { error: null };
      },
    }),
  };
  const db = {
    admin: { storage, from: query },
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      const job = args.p_job as string;
      if (mode.rpc === "reject" || jobs.get(job) === "succeeded") throw new MarketError("LEASE_LOST", "lease is no longer live");
      for (const a of args.p_artifacts as Array<{ bucket: string; objectKey: string; sha256: string }>) {
        artifacts.push({ job_id: job, attempt_id: args.p_attempt as string, bucket: a.bucket, object_key: a.objectKey, sha256: a.sha256 });
      }
      jobs.set(job, "succeeded");
      if (mode.rpc === "commit_reply_lost") throw new MarketError("INTERNAL_ERROR", "database operation failed", 500);
      return null;
    },
  } as unknown as Db;
  const deps = { db, now: () => new Date() } as unknown as Deps;
  return { deps, objects, removed, jobs, setRpc: (m: RpcMode) => (mode.rpc = m) };
}

function completion(text = "Result body") {
  const jobId = randomUUID();
  const attemptId = randomUUID();
  const artifactId = randomUUID();
  return {
    jobId,
    key: `jobs/${jobId}/${attemptId}/${artifactId}`,
    body: {
      attemptId,
      leaseToken: "t".repeat(40),
      envelope: {
        jobId,
        attemptId,
        leaseGeneration: 1,
        schemaVersion: "veilo.result.v1" as const,
        status: "complete" as const,
        summary: "done",
        artifacts: [{ artifactId, sha256: sha(text), mimeType: "text/plain" as const, bytes: Buffer.byteLength(text) }],
        sourceReferences: [],
      },
      artifactBodies: [{ artifactId, text }],
    },
  };
}

describe("completeJob reconciles uncertain commits before deleting artifacts", () => {
  it("keeps the stored result when the commit landed but its reply was lost", async () => {
    const f = fakeDeps({ rpc: "commit_reply_lost" });
    const c = completion();
    await expect(completeJob(f.deps, c.jobId, c.body)).resolves.toBeUndefined();
    expect(f.objects.has(c.key)).toBe(true);
    expect(f.removed).toEqual([]);
  });

  it("a retry of a committed completion succeeds without touching the stored result", async () => {
    const f = fakeDeps({ rpc: "commit" });
    const c = completion();
    await completeJob(f.deps, c.jobId, c.body);
    await expect(completeJob(f.deps, c.jobId, c.body)).resolves.toBeUndefined();
    expect(f.objects.has(c.key)).toBe(true);
    expect(f.removed).toEqual([]);
  });

  it("a retry after objects were stored but never committed reuses them and commits", async () => {
    const f = fakeDeps({ rpc: "commit" });
    const c = completion();
    f.objects.set(c.key, Buffer.from("Result body", "utf8"));
    await expect(completeJob(f.deps, c.jobId, c.body)).resolves.toBeUndefined();
    expect(f.jobs.get(c.jobId)).toBe("succeeded");
  });

  it("refuses a leftover object whose bytes differ from the envelope", async () => {
    const f = fakeDeps({ rpc: "commit" });
    const c = completion();
    f.objects.set(c.key, Buffer.from("something else", "utf8"));
    await expect(completeJob(f.deps, c.jobId, c.body)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(f.jobs.has(c.jobId)).toBe(false);
  });

  it("removes uploaded objects after a definitive rejection", async () => {
    const f = fakeDeps({ rpc: "reject" });
    const c = completion();
    f.jobs.set(c.jobId, "running");
    await expect(completeJob(f.deps, c.jobId, c.body)).rejects.toMatchObject({ code: "LEASE_LOST" });
    expect(f.removed).toEqual([c.key]);
  });

  it("keeps objects when the committed state cannot be read", async () => {
    const f = fakeDeps({ rpc: "commit_reply_lost", readFails: true });
    const c = completion();
    await expect(completeJob(f.deps, c.jobId, c.body)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(f.objects.has(c.key)).toBe(true);
    expect(f.removed).toEqual([]);
  });
});
