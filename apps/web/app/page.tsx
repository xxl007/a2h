import type { Metadata } from "next";
import { Home } from "./home";

export const metadata: Metadata = { title: "A2H" };

// STAGE and MCP_URL are the Lambda's run-time environment (infra/web.ts).
// Prerendering at build would freeze the CI build's values into the HTML.
export const dynamic = "force-dynamic";

export default function Page() {
  return <Home stage={process.env.STAGE} mcpUrl={process.env.MCP_URL} />;
}
