import { proxy } from "../../../../lib/server/proxy";
import { UPSTREAM_SERVICES, type UpstreamService } from "../../../../lib/server/upstream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Params {
  params: Promise<{ service: string; path: string[] }>;
}

async function handle(req: Request, { params }: Params): Promise<Response> {
  const { service, path } = await params;
  if (!(UPSTREAM_SERVICES as readonly string[]).includes(service)) {
    return Response.json({ error: { code: "NOT_FOUND", message: "no such endpoint" } }, { status: 404 });
  }
  return proxy(req, service as UpstreamService, path);
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
