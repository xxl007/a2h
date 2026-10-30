// Test Client ID Metadata Documents, non-production stages only
// (src/auth/test-fixtures.ts).
import { cimdFixture } from "../../../../src/auth/test-fixtures";
import { webConfigFromEnv } from "../../../../src/config";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }): Promise<Response> {
  const config = webConfigFromEnv(process.env);
  const doc = config.stage === "prod" ? undefined : cimdFixture((await params).name, config.baseURL);
  if (!doc) return new Response("Not found", { status: 404 });
  return Response.json(doc, { headers: { "cache-control": "no-store" } });
}
