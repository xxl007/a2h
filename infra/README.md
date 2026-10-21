# infra: A2H stacks (SST 4.17.2, Ion components)

`sst.config.ts` at the repo root is thin: it sets app `a2h`, `home: "aws"`, region `eu-west-3`, and calls `deploy($app.stage)` from `infra/index.ts`. One module per concern: `config.ts` (stage model, constants, owner-settable `domain` and `emailSender`), `vpc.ts`, `cluster.ts` (ECS cluster + ALB), `database.ts`, `storage.ts`, `email.ts`, `mcp.ts`, `worker.ts`, `web.ts`, `shared.ts`. Contract: `openspec/changes/m0-foundation/tasks.md` §Step 4.

**Nothing here is deployed by agents.** Deploys run only in CI through the OIDC role (`.github/workflows/`); the first `dev` deploy is the owner's (`docs/runbooks/aws-bootstrap.md`).

## Stages

| Stage | Creates | Borrows from dev | removal / protect |
|---|---|---|---|
| `dev` | VPC (2 AZ, no NAT), ECS cluster, ALB, Aurora (pg 17, 0-4 ACU, pauses after 10 min, Data API on), `Uploads` bucket, SES identity if `emailSender` is set, 8 SSM parameters, MCP + worker services, Web | nothing | `retain` / `true` |
| `pr-<n>` | MCP + worker services (`McpPr<n>`, `WorkerPr<n>`, Fargate Spot), listener rule, Web | VPC, cluster, ALB, Aurora, bucket, SES identity, via `static get` | `remove` / `false` |
| `prod` | everything of its own (Aurora min 0.5 ACU, no pause, no Data API); publishes nothing | nothing | `retain` / `true` |

Any other stage name is refused by `stageInfo()` so that a personal stage cannot create a second Aurora cluster by accident.

## SSM contract (`dev` publishes, `pr-*` reads at deploy time)

`/a2h/shared/` + `vpc-id`, `cluster-id` (cluster ARN), `alb-arn`, `aurora-cluster-id`, `aurora-cluster-arn`, `aurora-secret-arn`, `uploads-bucket`, `email-sender`. SSM rejects empty strings, so while no sender is configured `email-sender` holds `none` and `pr-*` stages skip the Email component. `pr-*` resolves the values with `aws.ssm.getParameter` (plain strings, because `Bucket.get` takes a string and the email branch is decided at program time). The CI workflows read the two Aurora ARNs to create and drop the `pr_<n>` schema through the RDS Data API.

## Routing on the shared ALB

HTTP listener on 80; with a `domain`, HTTPS on 443 and 80 redirects to 443, and rules attach to 443. Idle timeout **3600 s** (`cluster.ts`, `transform.loadBalancer`), required by the mcp-transport scenario "Idle stream survives". Rules: dev/prod `/mcp` 49000, `/mcp/*` 49001, `/healthz` 49002; `pr-<n>` `/pr-<n>/*` at 100 + n (n < 48900). Target health check: `/healthz` or `/pr-<n>/healthz`, every 15 s, expects 200.

With `domain` set: prod web `<domain>`, ALB `mcp.<domain>`; dev web `dev.<domain>`, ALB `mcp.dev.<domain>`; `pr-<n>` web `pr-<n>.dev.<domain>`, MCP on `mcp.dev.<domain>/pr-<n>/mcp`.

## What each service receives

MCP and worker (arm64, 0.25 vCPU / 0.5 GB; MCP scales 1-2 on dev/prod, 1-1 on pr; worker 1-1):
`PORT=3000`, `STAGE`, `MCP_BASE_PATH` (`/mcp` or `/pr-<n>/mcp`), `STORAGE_PREFIX` (`""` or `pr-<n>/`), `DB_SCHEMA` (`public` or `pr_<n>`), `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` injected by ECS from the Aurora secret (`ssm` -> task `secrets.valueFrom` `<secretArn>:password::`). Links: `Uploads` bucket and, when it exists, `Email` (least-privilege IAM on the task role).

**Database credentials, why not `link`:** SST's `link` on a Fargate service writes every linked property, including the Aurora password, into the task definition's plain `environment`. Injecting the secret through `ssm` keeps the password out of the task definition and out of `environment`; the app-side adapter (`apps/*/infra/`, step 5) composes `DATABASE_URL` in process and sets `search_path` to `DB_SCHEMA` only.

Web (`sst.aws.Nextjs`, Node 22, arm64, 1024 MB, 20 s, `warm` 1 on dev/prod and 0 on pr, no `regions`): `STAGE`, `DB_SCHEMA`, `STORAGE_PREFIX`, `MCP_URL`; linked to `Uploads` only. Web is created only when `apps/web` contains `next.config.{ts,mjs,js}`; until then the `web` output reads "not deployed (apps/web has no Next.js app yet)". Step 5 adds the app; nothing here changes.

Storage keys: `<tmp|uploads>/<STORAGE_PREFIX><key>`, so lifecycle rules (`tmp/` 7 days, `uploads/` `UPLOAD_RETENTION_DAYS` = 180) cover preview objects too.

## Outputs (`.sst/outputs.json`)

`stage`, `web`, `mcp` (ALB base URL + `MCP_BASE_PATH`), `albUrl`; on `dev` also `shared` (the eight identifiers).

## Typecheck and tests without AWS credentials

`pnpm typecheck` runs `sst install` (downloads the pinned providers and generates the gitignored `.sst/platform/config.d.ts`; no cloud access) and then `tsc` on `infra/*.ts` and `sst.config.ts`. tsc also reads SST's own `.ts` sources, so `infra/tsconfig.json` turns off four flags those sources do not satisfy (`verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`); `strict` stays on. `pnpm test` runs `infra/test/config.test.ts` (stage model, priorities, SSM names, idle timeout) with `node --test`.
