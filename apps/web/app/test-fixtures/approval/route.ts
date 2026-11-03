// Test data for the approval page's e2e flows, non-production stages only
// (src/approval/fixture.ts). Prod answers 404 before reading anything.
import { handleApprovalFixture } from "../../../src/approval/fixture";
import { webConfigFromEnv } from "../../../src/config";
import { getRuntime } from "../../../src/server/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (webConfigFromEnv(process.env).stage === "prod") return new Response("Not found", { status: 404 });
  const runtime = await getRuntime();
  return handleApprovalFixture(
    {
      stage: runtime.config.stage,
      db: runtime.db,
      feeRate: runtime.config.feeRate,
      defaultPolicy: runtime.config.defaultPolicy,
      baseURL: runtime.config.baseURL,
      principalId: async () => (await runtime.auth.api.getSession({ headers: request.headers }))?.user.id,
      logger: runtime.logger,
    },
    request,
  );
}
