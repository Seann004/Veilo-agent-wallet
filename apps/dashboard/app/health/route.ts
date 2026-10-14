export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ service: "dashboard", status: "ok" });
}
