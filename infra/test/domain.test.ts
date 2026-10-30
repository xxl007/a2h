// Product domain, TLS and SES identity for every stage, and the Data API flag
// of each cluster (openspec/changes/m1-hosted-connector, task 1.2).
// Spec platform/hosted-endpoint: "Stage hostnames under the product domain"
// and "HTTPS only"; spec platform/preview-environments: "A PR gets a preview
// stage". The component functions (cluster.ts, email.ts, database.ts, web.ts)
// run here against stubbed SST globals that record their arguments, so what
// is asserted is what `sst deploy` would receive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { domain, emailSender, hostnames, publicUrls, stageInfo } from "../config.ts";
import { albBaseUrl, createAlb, serviceListener } from "../cluster.ts";
import { createDatabase } from "../database.ts";
import { createEmail } from "../email.ts";
import { createWeb } from "../web.ts";

const APEX = "a2h-protocol.org";
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

type Args = Record<string, unknown>;
interface Recorded {
  alb?: Args;
  email?: Args;
  aurora: Args[];
  web?: Args;
}

const DNS_MARKER = { provider: "route53" };

/** Installs `sst`, `$output` and `$cli` stubs; returns what the components receive. */
function stubSst(): Recorded {
  const rec: Recorded = { aurora: [] };
  const g = globalThis as unknown as Record<string, unknown>;
  g.sst = {
    aws: {
      dns: () => DNS_MARKER,
      Alb: class {
        constructor(_name: string, args: Args) {
          rec.alb = args;
        }
      },
      Email: class {
        constructor(_name: string, args: Args) {
          rec.email = args;
        }
      },
      Aurora: class {
        constructor(_name: string, args: Args) {
          rec.aurora.push(args);
        }
      },
      Nextjs: class {
        constructor(_name: string, args: Args) {
          rec.web = args;
        }
      },
    },
  };
  g.$output = (v: unknown) => v;
  g.$cli = { paths: { root: REPO_ROOT } };
  return rec;
}

const fakeVpc = {} as unknown as sst.aws.Vpc;
const fakeAlb = {} as unknown as sst.aws.Alb;

test("the product domain is a2h-protocol.org", () => {
  assert.equal(domain, APEX);
});

test("Stage hostnames under the product domain: prod, dev, pr-12", () => {
  assert.deepEqual(hostnames(stageInfo("prod"), APEX), { web: APEX, alb: `mcp.${APEX}` });
  assert.deepEqual(hostnames(stageInfo("dev"), APEX), { web: `dev.${APEX}`, alb: `mcp.dev.${APEX}` });
  assert.deepEqual(hostnames(stageInfo("pr-12"), APEX), { web: `pr-12.dev.${APEX}`, alb: `mcp.dev.${APEX}` });
});

test("public URLs are HTTPS under the domain: web and MCP endpoint per stage", () => {
  assert.deepEqual(publicUrls(stageInfo("prod"), APEX), {
    web: `https://${APEX}`,
    albBase: `https://mcp.${APEX}`,
    mcp: `https://mcp.${APEX}/mcp`,
  });
  assert.deepEqual(publicUrls(stageInfo("dev"), APEX), {
    web: `https://dev.${APEX}`,
    albBase: `https://mcp.dev.${APEX}`,
    mcp: `https://mcp.dev.${APEX}/mcp`,
  });
  assert.deepEqual(publicUrls(stageInfo("pr-12"), APEX), {
    web: `https://pr-12.dev.${APEX}`,
    albBase: `https://mcp.dev.${APEX}`,
    mcp: `https://mcp.dev.${APEX}/pr-12/mcp`,
  });
});

test("albBaseUrl: dev's MCP base is https://mcp.dev.<domain>, and pr-12's MCP URL is under it", () => {
  stubSst();
  const dev = stageInfo("dev");
  assert.equal(albBaseUrl(dev, fakeAlb), `https://mcp.dev.${APEX}`);
  const pr = stageInfo("pr-12");
  // index.ts composes the MCP output as `${albBaseUrl}${mcpBasePath}`.
  assert.equal(`${albBaseUrl(pr, fakeAlb) as unknown as string}${pr.mcpBasePath}`, `https://mcp.dev.${APEX}/pr-12/mcp`);
});

test("service rules attach to the 443/https listener", () => {
  assert.equal(serviceListener(), "443/https");
});

test("HTTPS only: the ALB has 80 redirecting 301 to 443, and 443 with the stage's hostname", () => {
  for (const [name, host] of [
    ["dev", `mcp.dev.${APEX}`],
    ["prod", `mcp.${APEX}`],
  ] as const) {
    const rec = stubSst();
    createAlb(stageInfo(name), fakeVpc);
    const args = rec.alb as {
      listeners: { port: number; protocol: string }[];
      domain: string;
      transform: { listener: (a: Args) => void; loadBalancer: (a: Args) => void };
    };
    assert.deepEqual(args.listeners, [
      { port: 80, protocol: "http" },
      { port: 443, protocol: "https" },
    ]);
    assert.equal(args.domain, host);

    const http: Args = { port: 80 };
    args.transform.listener(http);
    assert.deepEqual(http.defaultActions, [
      { type: "redirect", redirect: { port: "443", protocol: "HTTPS", statusCode: "HTTP_301" } },
    ]);
    const https: Args = { port: 443 };
    args.transform.listener(https);
    assert.equal(https.defaultActions, undefined, "443 keeps SST's default action");
  }
});

test("web domain: pr-12.dev.<domain> on pr-12, dev.<domain> on dev", () => {
  for (const [name, host] of [
    ["pr-12", `pr-12.dev.${APEX}`],
    ["dev", `dev.${APEX}`],
  ] as const) {
    const rec = stubSst();
    createWeb(stageInfo(name), {
      storage: { mode: "link", bucket: { name: "bucket" } as unknown as sst.aws.Bucket },
      mcpUrl: "https://example.invalid/mcp",
    });
    assert.equal(rec.web?.domain, host);
  }
});

test("SES identity is the domain, with its DNS records created in the hosted zone", () => {
  assert.equal(emailSender, APEX);
  const rec = stubSst();
  createEmail();
  assert.equal(rec.email?.sender, APEX);
  // sst.aws.dns(): SST 4.17.2 Email then creates the DKIM CNAMEs and, with no
  // `dmarc` argument, a `v=DMARC1; p=none;` TXT record at _dmarc.<domain>.
  assert.equal(rec.email?.dns, DNS_MARKER);
  assert.equal(rec.email?.dmarc, undefined, "SST's default DMARC record (p=none) is kept");
});

test("Data API: enabled on the prod cluster (design D2) and still on dev", () => {
  const rec = stubSst();
  createDatabase(stageInfo("dev"), fakeVpc);
  createDatabase(stageInfo("prod"), fakeVpc);
  const [dev, prod] = rec.aurora;
  assert.equal(dev?.dataApi, true);
  assert.equal(prod?.dataApi, true);
  // Nothing else about either cluster changes.
  assert.deepEqual(dev?.scaling, { min: "0 ACU", max: "4 ACU", pauseAfter: "10 minutes" });
  assert.deepEqual(prod?.scaling, { min: "0.5 ACU", max: "4 ACU" });
});
