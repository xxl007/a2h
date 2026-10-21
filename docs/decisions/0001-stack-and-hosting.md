# ADR 0001: Stack and hosting

- Status: accepted (product owner, 2026-10-21)
- Date: 2026-10-21
- Deciders: product owner (Galem L.), PM agent
- Scope: the runtime stack, the AWS layout in eu-west-3, and the hosting choice for `apps/web` (Amplify Hosting vs OpenNext on CloudFront + Lambda) that CLAUDE.md §Stack left to SST and this ADR.
- Related: CLAUDE.md §Stack; PRD §10 (M0), §11 (availability, EU residency, 2 s on 3G); `openspec/changes/m0-foundation/specs/platform/*`.

## Context

CLAUDE.md fixes most of the stack: pnpm + Turborepo monorepo, TypeScript, Node 22; Next.js App Router for `apps/web`; the MCP server (`@modelcontextprotocol/sdk`, Streamable HTTP, stateless) and the pg-boss worker as ECS Fargate services behind one ALB with ≥ 1 h idle timeout (App Runner excluded for its 120 s request limit); Aurora Serverless v2; SES; S3 with lifecycle rules; Secrets Manager; IAM roles per service; single region eu-west-3; SST v3 for infrastructure; per-PR preview stages sharing the dev Aurora cluster with one schema per PR; business logic provider-neutral so that changing cloud is a deployment change.

The one open point is how `apps/web` is served. Two candidates were named:

- **Amplify Hosting** (managed Next.js SSR, "Amplify Hosting compute"). Available in eu-west-3 (AWS endpoints list, Paris). Supports Next.js 12–15, SSR, ISR, middleware, image optimisation and the App Router. Documented **unsupported** features: Next.js streaming, on-demand ISR, edge API routes, running middleware on static assets, `unstable_after`. Previews come from Amplify's own branch/PR preview feature (50 branches per app), configured in the Amplify console or through the Amplify CloudFormation/Pulumi resources, outside SST's stage model. Pricing is per build minute, per request token and per GB served.
- **OpenNext on CloudFront + Lambda** through `sst.aws.Nextjs`. SST builds the app with OpenNext (`@opennextjs/aws`, auto-selected 3.9.x for Next 15+) and creates CloudFront, S3 for assets, a Lambda server function (Node 22 or 24 runtime, 128 MB–10 GB, default 1024 MB, default 20 s timeout, `warm` option, `regions` for multi-region), an image-optimisation Lambda, and an ISR revalidation queue (SQS) and table (DynamoDB). OpenNext targets all Next.js 15 features including App Router, server actions, ISR, middleware, `after` and `use cache`; Lambda response **streaming** is supported via the `aws-lambda-streaming` wrapper. OpenNext is maintained by the SST community. The component accepts `vpc`, `link` (for Aurora and buckets) and `domain`, and lives in the same SST stage as everything else.

What matters for A2H specifically: the participant request page must load in under 2 s on 3G (PRD §11), so it is server-rendered with minimal client JS; the principal dashboard and the participant PWA use server actions for forms (CLAUDE.md); previews must be one SST stage per PR, including the web app, so that the product owner validates one URL set per change; data must stay in eu-west-3; and the web tier does not carry SSE (that is the MCP service on Fargate), so Lambda's 60 s CloudFront default and streaming caveats are not on the critical path.

## Decision

1. **`apps/web` is deployed with OpenNext via `sst.aws.Nextjs`** on CloudFront + Lambda (Node 22 runtime, arm64, 1024 MB, 20 s timeout, `warm: 1` on `dev`/`prod` stages and `0` on `pr-*` stages), with static assets in S3 in eu-west-3 and CloudFront as the global edge. The server function runs in eu-west-3 only (`regions` unset) to keep SSR and data access in the EU. Linked to the Aurora cluster and the uploads bucket through SST `link` so credentials are injected as IAM, never as keys.
2. **Amplify Hosting is not used.** Its lack of Next.js streaming and on-demand ISR would constrain the App Router roadmap, and its preview model lives outside SST stages, which would give each PR two independent deployment systems to reconcile. It remains a documented fallback: if Lambda cold starts or OpenNext breakage ever threaten the 2 s budget, moving `apps/web` to Amplify or to a Fargate-hosted Next.js standalone server is a change to `infra/` only, because `apps/web` contains no AWS SDK calls (CLAUDE.md provider-neutrality rule).
3. **The rest of the stack stands as CLAUDE.md states it.** Per service: `apps/mcp` and `apps/worker` as ECS Fargate services (arm64 containers) behind one internal-facing ALB with a 3600 s idle timeout, the MCP service exposed on a public listener with TLS; Aurora Serverless v2 PostgreSQL (dev cluster shared by `dev` and `pr-*` stages, one schema per PR, separate cluster for `prod` when it exists); SES identity for the sending domain with React Email templates rendered by the worker behind a provider-neutral `Mailer` interface; S3 buckets for voice notes and attachments with presigned uploads and lifecycle expiry; Secrets Manager for secrets with IAM roles per service; CloudWatch structured logs and metrics; no long-lived access keys in CI (GitHub Actions assumes a role via OIDC).
4. **Previews.** One SST stage per PR named `pr-<n>`: its own Nextjs distribution, its own Fargate services and ALB listener rules, its own Postgres schema `pr_<n>` on the shared dev cluster (created by the deploy workflow, dropped by the teardown workflow), its own SES configuration set sharing the verified identity, and prefixed S3 keys in the dev buckets. The PR comment carries the web URL and the MCP endpoint URL.
5. **Transcription and payments** stay behind interfaces (`Transcriber`: Amazon Transcribe first, Deepgram fallback; `Payments`: Stripe) so that neither the hosting choice nor the cloud choice reaches business code.

## Consequences

- `infra/` defines the stages, the Nextjs component and the Fargate services in one `sst.config.ts` with stage-dependent sizing; the per-PR schema lifecycle is a small deploy-time step in the workflow, not an SST resource.
- CloudFront's 60 s origin timeout bounds any SSR request; long-running work belongs to the worker. Lambda cold starts on `pr-*` stages are accepted; `dev` and `prod` use `warm`.
- OpenNext is community-maintained; the lockfile pins `@opennextjs/aws` and SST versions, and Context7 is consulted before upgrading either. A breakage has a documented exit (Decision 2).
- The web tier has no SSE or MCP traffic; the ≥ 1 h idle timeout requirement applies to the ALB in front of Fargate, where it is configured explicitly and tested by the `mcp-transport` spec scenario "Idle stream survives".
- ACM certificates for CloudFront must be issued in us-east-1 (CloudFront requirement); this is a certificate-only exception to single-region and holds no data.
- Cost at M0 scale is dominated by Aurora Serverless v2 minimum capacity and the ALB hourly charge; Lambda and CloudFront are near zero for previews.

## Alternatives rejected

- **Amplify Hosting for `apps/web`**: no streaming or on-demand ISR; previews outside SST stages; less control over the server runtime. Kept as fallback.
- **Next.js standalone server on ECS Fargate** behind the same ALB: full Node runtime and no Lambda limits, but always-on cost per preview stage, slower preview creation, and no CDN-side static asset handling without extra work. Fallback option if Lambda becomes a constraint.
- **Vercel** for the web tier: simplest Next.js hosting, but data and compute would leave the AWS account and the eu-west-3 single-region posture, and previews would again sit outside SST.
- **App Runner** for mcp/worker: excluded by CLAUDE.md (120 s request limit breaks streams).
- **One schema shared by all previews** or **one Aurora cluster per PR**: the first leaks data between PRs; the second multiplies cost and creation time. A schema per PR is the middle.
- **Lambda for the MCP server**: incompatible with hour-long Streamable HTTP responses and with the stateless-but-long-lived connection model; Fargate is the fit.
