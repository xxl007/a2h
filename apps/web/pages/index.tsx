// The home page, `/`, on the Pages Router: the one page of the app that ships
// no client JavaScript (`unstable_runtimeJS: false`, Pages Router only). It is
// two kilobytes of server-rendered text; the App Router cannot render a route
// without its React runtime (95-104 KB on the wire, brotli or gzip), which put
// the page within a cold CloudFront edge's compression choice of the 100 KB
// budget of tests/e2e/hello.spec.ts (skill §8: no client JS required to read).
// The body stays the pure component in app/home.tsx; STAGE and MCP_URL are the
// Lambda's run-time environment (infra/web.ts), read per request, never frozen
// into the build. Every other screen stays on the App Router.
import type { GetServerSideProps } from "next";
import Head from "next/head";
import { Home, type HomeProps } from "../app/home";

export const config = { unstable_runtimeJS: false };

export const getServerSideProps: GetServerSideProps<HomeProps> = () =>
  Promise.resolve({
    props: {
      ...(process.env["STAGE"] !== undefined ? { stage: process.env["STAGE"] } : {}),
      ...(process.env["MCP_URL"] !== undefined ? { mcpUrl: process.env["MCP_URL"] } : {}),
    },
  });

export default function HomePage(props: HomeProps) {
  return (
    <>
      <Head>
        <title>A2H</title>
        <meta name="description" content="Agent-to-Human: a protocol that lets AI agents reach consenting humans." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <Home {...props} />
    </>
  );
}
