# infra: A2H stacks (SST 4.17.2, Ion components)

`sst.config.ts` at the repo root is thin: it sets app `a2h`, `home: "aws"`, region `eu-west-3`, registers the permissions-boundary transform, and calls `deploy($app.stage)` from `infra/index.ts`. One module per concern: `config.ts` (stage model, constants, owner-settable `domain` and `emailSender`), `access.ts` (database login and storage grant per stage; pure), `vpc.ts`, `cluster.ts` (ECS cluster + ALB), `database.ts`, `storage.ts`, `email.ts`, `mcp.ts`, `worker.ts`, `web.ts`, `shared.ts`. Contract: `openspec/changes/m0-foundation/tasks.md` §Step 4 and **Contract amendment 1**.

**Nothing here is deployed by agents.** Deploys run only in CI through the OIDC role (`.github/workflows/`); the first `dev` deploy is the owner's (`docs/runbooks/aws-bootstrap.md`).

## Stages

| Stage | Creates | Borrows from dev | removal / protect |
|---|---|---|---|
| `dev` | VPC (2 AZ, no NAT), ECS cluster, ALB, Aurora (pg 17, 0-4 ACU, pauses after 10 min, Data API on), `Uploads` bucket, SES identity if `emailSender` is set, 8 SSM parameters, MCP + worker services, Web | nothing | `retain` / `true` |
| `pr-<n>` | MCP + worker services (`McpPr<n>`, `WorkerPr<n>`, Fargate Spot), listener rule, Web | VPC, cluster, ALB, SES identity via `static get`; Aurora endpoint via the `aws.rds.getCluster` data source (not `Aurora.get`, see below); bucket by name only (not linked) | `remove` / `false` |
| `prod` | everything of its own (Aurora min 0.5 ACU, no pause, no Data API); publishes nothing | nothing | `retain` / `true` |

Any other stage name is refused by `stageInfo()` so that a personal stage cannot create a second Aurora cluster by accident.

## SSM contract (`dev` publishes, `pr-*` reads at deploy time)

`/a2h/shared/` + `vpc-id`, `cluster-id` (cluster ARN), `alb-arn`, `aurora-cluster-id`, `aurora-cluster-arn`, `aurora-secret-arn`, `uploads-bucket`, `email-sender`. SSM rejects empty strings, so while no sender is configured `email-sender` holds `none` and `pr-*` stages skip the Email component. `pr-*` resolves the values it uses (`PR_STAGE_READS` in `config.ts`: everything except the two Aurora ARNs) with `aws.ssm.getParameter`, as plain strings, because the scoped storage ARNs and the email branch are decided at program time. Only the CI workflows read the two Aurora ARNs, to create and drop the `pr_<n>` schema and login through the RDS Data API; the `pr-*` stage never reads the master secret ARN.

## Routing on the shared ALB

HTTP listener on 80; with a `domain`, HTTPS on 443 and 80 redirects to 443, and rules attach to 443. Idle timeout **3600 s** (`cluster.ts`, `transform.loadBalancer`), required by the mcp-transport scenario "Idle stream survives". Rules: dev/prod `/mcp` 49000, `/mcp/*` 49001, `/healthz` 49002; `pr-<n>` `/pr-<n>/*` at 100 + n (n < 48900). Target health check: `/healthz` or `/pr-<n>/healthz`, every 15 s, expects 200. The path has one source: `healthPathFor()` in `apps/mcp/src/health-path.ts` (pure, no SST, no imports), which both the server and `config.ts` `stageInfo()` import; `infra/test/config.test.ts` asserts they agree for `/mcp` and `/pr-12/mcp`.

With `domain` set: prod web `<domain>`, ALB `mcp.<domain>`; dev web `dev.<domain>`, ALB `mcp.dev.<domain>`; `pr-<n>` web `pr-<n>.dev.<domain>`, MCP on `mcp.dev.<domain>/pr-<n>/mcp`.

## What each service receives

MCP and worker (arm64, 0.25 vCPU / 0.5 GB; MCP scales 1-2 on dev/prod, 1-1 on pr; worker 1-1):
`PORT=3000`, `STAGE`, `MCP_BASE_PATH` (`/mcp` or `/pr-<n>/mcp`), `STORAGE_PREFIX` (`dev/`, `prod/` or `pr-<n>/`), `UPLOADS_BUCKET`, `DB_SCHEMA` (`public` or `pr_<n>`), `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` injected by ECS from Secrets Manager (`ssm` -> task `secrets.valueFrom` `<secretArn>:password::`; never in plain `environment`). Both services set **`wait: true`** on every stage: `sst deploy` waits for ECS steady state, so an unhealthy or crash-looping deploy fails the job.

| | `dev`, `prod` | `pr-<n>` |
|---|---|---|
| `DB_USER` | Aurora master user (M0) | `pr_<n>` |
| `DB_PASSWORD` from | Aurora master secret (SST-managed) | `a2h/pr-<n>/db`, key `password`, looked up **by name at deploy time** (`aws.secretsmanager.getSecret`); the preview workflow creates it with `pr-schema.sh create <n>` before `sst deploy`, so a missing secret fails the deploy |
| Uploads bucket | `link` (SST least-privilege IAM, `Resource.Uploads`) | not linked; `permissions` `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on `arn:aws:s3:::<bucket>/uploads/pr-<n>/*` and `arn:aws:s3:::<bucket>/tmp/pr-<n>/*` only |
| `Email` | linked when it exists | linked when it exists |

The mapping is pure and unit-tested (`access.ts`, `infra/test/access.test.ts`): user and secret names, `valueFrom` exactly `<arn>:password::`, `DB_PASSWORD` never in `environment`, a pr stage refuses the master source and any secret other than its own `a2h/pr-<n>/db`, and the two S3 object ARNs.

**Why pr stages do not use `Aurora.get`:** in SST 4.17.2, `Aurora.get` (`.sst/platform/src/components/aws/aurora.ts`, `reference()`) calls `secretsmanager.getSecretVersionOutput` on the master secret to fill its `password` property. That would read the master password into every preview's state and require the preview role to read it. `pr-*` takes host, port and database name from `aws.rds.getClusterOutput` instead, which returns no credential.

**Database credentials, why not `link`:** SST's `link` on a Fargate service writes every linked property, including the Aurora password, into the task definition's plain `environment`. Injecting the secret through `ssm` keeps the password out of the task definition and out of `environment`; the app-side adapter (`apps/*/infra/`, step 5) composes `DATABASE_URL` in process and sets `search_path` to `DB_SCHEMA` only.

Web (`sst.aws.Nextjs`, Node 22, arm64, 1024 MB, 20 s, `warm` 1 on dev/prod and 0 on pr, no `regions`): `STAGE`, `DB_SCHEMA`, `STORAGE_PREFIX`, `MCP_URL`, `UPLOADS_BUCKET`; storage as in the table above (dev/prod `link` to `Uploads`; pr the same three object permissions on the server function's role, no link). Web is created only when `apps/web` contains `next.config.{ts,mjs,js}`; until then the `web` output reads "not deployed (apps/web has no Next.js app yet)". Step 5 adds the app; nothing here changes.

Storage keys: `<tmp|uploads>/<STORAGE_PREFIX><key>` with `STORAGE_PREFIX` `dev/`, `prod/` or `pr-<n>/` (`STORAGE_AREAS` in `config.ts`, shared by the lifecycle rules and the preview grants). Every stage has a prefix and none is a prefix of another, so a preview's grant on `uploads/pr-<n>/*` can never reach a `dev` object (a dev key is `uploads/dev/…`, never `uploads/pr-<n>/…`; tested in `infra/test/access.test.ts` and `config.test.ts`). The lifecycle rules sit at the area roots (`tmp/` 7 days, `uploads/` `UPLOAD_RETENTION_DAYS` = 180; `lifecycleRules()` in `storage.ts`) and so cover every stage's objects (`infra/test/storage.test.ts`).

## Permissions boundary on every workload role

`sst.config.ts` `run()` registers `$transform(aws.iam.Role, …)` **before** `infra/index.ts` is imported. It sets `permissionsBoundary` to `arn:aws:iam::<account>:policy/a2h-workload-boundary` (`WORKLOAD_BOUNDARY_POLICY_NAME` and `workloadBoundaryArn()` in `config.ts`, unit-tested), with the account from `aws.getCallerIdentityOutput()`. The policy is created by the bootstrap (`infra/bootstrap/`); the deploy roles may create or modify `role/a2h-*` only when it is attached.

How it reaches roles inside components (checked in the 4.17.2 sources): `$transform` on a non-`sst:` type calls Pulumi `runtime.registerStackTransformation` (`.sst/platform/src/components/component.ts`). Pulumi's `Resource` constructor copies its parent's transformations, falling back to the stack's, at construction time (`@pulumi/pulumi/resource.js`). So every `aws.iam.Role` created by a component constructed after registration gets the boundary, including roles created later inside `.apply()`. A component constructed before registration would not pass it to its children; this is why the transform comes first.

Role-creating sites in the components this app uses:

| Component (file:line in `.sst/platform/src/components/aws/`) | Role | Created here? | Boundary |
|---|---|---|---|
| `Service` → `fargate.ts:991` `createTaskRole` | `<Svc>TaskRole` | yes, MCP and worker, every stage | covered |
| `Service` → `fargate.ts:1023` `createExecutionRole` | `<Svc>ExecutionRole` | yes, MCP and worker, every stage | covered |
| `Nextjs` → `ssr-site.ts:1466` server `Function` → `function.ts:2274` | `WebServerRole` | yes, once `apps/web` has a Next.js app | covered |
| `Nextjs` → `ssr-site.ts:1603` image optimiser `Function` → `function.ts:2274` | image optimiser role | yes, same | covered |
| `Nextjs` → `nextjs.ts:878` revalidation queue subscriber (`Queue.subscribe` → `Function`) → `function.ts:2274` | revalidation consumer role | yes, same | covered |
| `Nextjs` → `nextjs.ts:956` revalidation table seeder `Function` → `function.ts:2274` | seeder role | yes, when OpenNext emits an initialization function (tag cache) | covered |
| `Nextjs` → `ssr-site.ts:1332` Lambda@Edge role | `EdgeFunctionRole` | no (only with `protection: "oac-with-edge-signing"`) | would be covered |
| `Vpc` → `vpc.ts:1107` NAT instance role | `NatInstanceRole` | no (`nat` not set) | would be covered |
| `Vpc` → `vpc.ts:1387` bastion role | `BastionRole` | no (`bastion` not set) | would be covered |
| `Aurora` → `aurora.ts:1098` RDS Proxy role | `ProxyRole` | no (`proxy` not set) | would be covered |
| `Alb`, `Cluster`, `Bucket`, `Email` | none | — | — |
| `function.ts:2231`, `fargate.ts:958` and `:1016`, `vpc.ts:1101` (`iam.Role.get` when a role is passed in) | existing role, read only | no | skipped by the transform (`opts.id`): nothing is created |

Not covered by this transform, by nature: AWS service-linked roles (`AWSServiceRoleForECS`, `…ForRDS`, `…ForElasticLoadBalancing`, `…ForApplicationAutoScaling_ECSService`) are created by AWS, not by this program, and cannot carry a boundary; the bootstrap must allow or pre-create them. The transform is verified by reading the sources, not by a deploy: no agent runs `sst diff` or `sst deploy`.

## Residual risks (M0, accepted; documented by the PM in `docs/runbooks/aws-bootstrap.md`)

- **`dev` still uses the Aurora master user.** Its services log in as the master user and can reach every `pr_<n>` schema. Only `pr-*` stages have their own login. A per-stage login for `dev` is a later change.
- **The preview deploy role can still modify `dev` resources.** `gha-a2h-preview` has PowerUser-level rights (bounded by the `role/a2h-*` + boundary condition for IAM), and `dev` and `pr-*` share one account, VPC, cluster, ALB, Aurora cluster and bucket. A malicious PR branch that edits `infra/` runs with that role. The scoped storage grant and the per-PR login limit what a preview's *runtime* can touch, not what its *deploy* can.
- **SST's Fargate execution role allows `secretsmanager:GetSecretValue` on `*`** (`fargate.ts`, `ReadSsmAndSecrets`). The ECS agent fetches only the secrets named in the task definition (`a2h/pr-<n>/db` on previews), and the container never assumes the execution role, but the role itself is not scoped to that secret.

## Outputs (`.sst/outputs.json`)

`stage`, `web`, `mcp` (ALB base URL + `MCP_BASE_PATH`), `albUrl`; on `dev` also `shared` (the eight identifiers).

## Typecheck and tests without AWS credentials

`pnpm typecheck` runs `sst install` (downloads the pinned providers and generates the gitignored `.sst/platform/config.d.ts`; no cloud access) and then `tsc` on `infra/*.ts` and `sst.config.ts`. tsc also reads SST's own `.ts` sources, so `infra/tsconfig.json` turns off four flags those sources do not satisfy (`verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`); `strict` stays on. `pnpm test` runs `infra/test/config.test.ts` (stage model, priorities, SSM names, idle timeout, boundary ARN, pr reads, health-path agreement) and `infra/test/access.test.ts` (per-PR login, valueFrom, scoped storage ARNs) with `node --test`.
