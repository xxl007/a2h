# infra: A2H stacks (SST 4.17.2, Ion components)

`sst.config.ts` at the repo root is thin: it sets app `a2h`, `home: "aws"`, region `eu-west-3`, registers the role transform (permissions boundary and `a2h-<stage>-` role names), and calls `deploy($app.stage)` from `infra/index.ts`. One module per concern: `config.ts` (stage model, constants, owner-settable `domain` and `emailSender`), `access.ts` (database login and storage grant per stage; pure), `vpc.ts`, `cluster.ts` (ECS cluster + ALB), `database.ts`, `storage.ts`, `email.ts`, `mcp.ts`, `worker.ts`, `web.ts`, `shared.ts`, `edge.ts` (WAF rule; pure), `waf.ts` (web ACLs), `allowlist.ts` (sign-in allow-list parameter). Contract: `openspec/changes/m0-foundation/tasks.md` §Step 4 and **Contract amendment 1**.

**Nothing here is deployed by agents.** Deploys run only in CI through the OIDC role (`.github/workflows/`); the first `dev` deploy is the owner's (`docs/runbooks/aws-bootstrap.md`).

## Stages

| Stage | Creates | Borrows from dev | removal / protect |
|---|---|---|---|
| `dev` | VPC (2 AZ, no NAT), ECS cluster, ALB, Aurora (pg 17, 0-4 ACU, pauses after 10 min, Data API on), `Uploads` bucket, SES domain identity for `a2h-protocol.org` (DKIM and DMARC records in the zone), 9 shared SSM parameters, the allow-list parameter `/a2h/shared/principal-allowlist`, web ACLs (REGIONAL on the ALB, CLOUDFRONT in us-east-1 for the web), MCP + worker services, Web | nothing | `retain` / `true` |
| `pr-<n>` | MCP + worker services (`McpPr<n>`, `WorkerPr<n>`, Fargate Spot), two listener rules, Web, its own allow-list parameter `/a2h/pr-<n>/principal-allowlist` | VPC, cluster, ALB (with dev's REGIONAL web ACL), dev's CLOUDFRONT web ACL on its distribution, SES identity via `static get`; Aurora endpoint via the `aws.rds.getCluster` data source (not `Aurora.get`, see below); bucket by name only (not linked) | `remove` / `false` |
| `prod` | everything of its own (Aurora min 0.5 ACU, no pause, Data API on since m1-hosted-connector D2, not yet deployed), its own web ACLs and `/a2h/prod/principal-allowlist`; publishes nothing | nothing | `retain` / `true` |

Any other stage name is refused by `stageInfo()` so that a personal stage cannot create a second Aurora cluster by accident.

## SSM contract (`dev` publishes, `pr-*` reads at deploy time)

`/a2h/shared/` + `vpc-id`, `cluster-id` (cluster ARN), `alb-arn`, `aurora-cluster-id`, `aurora-cluster-arn`, `aurora-secret-arn`, `uploads-bucket`, `email-sender`, `web-acl-cloudfront-arn` (m1-hosted-connector D5). `pr-*` reads `web-acl-cloudfront-arn` only if present (`PR_STAGE_OPTIONAL_READS`): dev publishes it from its first deploy with task 8.1, and a preview deployed before that gets no web ACL on its distribution (the deploy prints a warning) rather than failing; move it to `PR_STAGE_READS` once dev has it. SSM rejects empty strings, so while no sender is configured `email-sender` holds `none` and `pr-*` stages skip the Email component. `pr-*` resolves the values it uses (`PR_STAGE_READS` in `config.ts`: everything except the two Aurora ARNs) with `aws.ssm.getParameter`, as plain strings, because the scoped storage ARNs and the email branch are decided at program time. Only the CI workflows read the two Aurora ARNs, to create and drop the `pr_<n>` schema and login through the RDS Data API; the `pr-*` stage never reads the master secret ARN.

## Routing on the shared ALB

Two listeners: HTTPS on 443 with the stage's ACM certificate (DNS-validated in the zone), where every rule attaches (`serviceListener()` = `443/https`); HTTP on 80, whose default action is a 301 to the same URL on 443 and nothing else (spec `platform/hosted-endpoint`, "HTTP redirected"). Both come from `domain` in `config.ts`; unset it and the ALB falls back to 80 only with rules on 80 (the rollback, design Migration Plan). Idle timeout **4000 s**, the AWS maximum (`ALB_IDLE_TIMEOUT_SECONDS` in `config.ts`, applied in `cluster.ts` `transform.loadBalancer`), required by the mcp-transport scenario "Idle stream survives": 61 minutes idle is 3660 s, so 3600 would cut it. The MCP server keeps idle keep-alive connections for 4010 s (`apps/mcp/src/http-timeouts.ts`) so that the ALB, not Node, closes them first; `infra/test/config.test.ts` asserts both. Rules: dev/prod `/mcp` 49000, `/mcp/*` 49001, `/healthz` 49002, `/.well-known/oauth-protected-resource/mcp` 49003; `pr-<n>` `/pr-<n>/*` at 100 + n and `/.well-known/oauth-protected-resource/pr-<n>/mcp` at 20000 + n, two disjoint bands, so n <= 19899 (`stageInfo()` refuses larger PR numbers). The well-known rules carry the path-aware protected-resource metadata (RFC 9728, m1-hosted-connector D3) that the mcp service answers; without them the 401 challenge would point at a URL the service never receives. `StageInfo.metadataPath` is asserted equal to the path apps/mcp derives (`createGate().metadataPath`, the SDK's `getOAuthProtectedResourceMetadataUrl`) in `infra/test/config.test.ts`. Target health check: `/healthz` or `/pr-<n>/healthz`, every 15 s, expects 200. The path has one source: `healthPathFor()` in `apps/mcp/src/health-path.ts` (pure, no SST, no imports), which both the server and `config.ts` `stageInfo()` import; `infra/test/config.test.ts` asserts they agree for `/mcp` and `/pr-12/mcp`.

## Limits and the edge rate limit (m1-hosted-connector D5)

Stage configuration, `limitsFor(stage)` in `config.ts` next to `developmentPolicy`:

| Stage | `perMinute` / `perDay` (tool calls per principal) | `pingMaxConcurrent` (per instance) | `edgeRequestsPer5Minutes` (per source address) |
|---|---|---|---|
| `dev`, `pr-<n>` | 600 / 20,000 | 4 | 3,000 (dev's web ACLs, previews included: each verify run comes from one runner address) |
| `prod` | 60 / 2,000 | 4 | 600 |

The mcp service receives the first three as `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_PER_DAY`, `PING_MAX_CONCURRENT` (`service-env.ts`). The edge limit is enforced by AWS WAF only (`edge.ts`, `waf.ts`): dev and prod each create a REGIONAL web ACL `a2h-<stage>-mcp-edge` associated with their ALB, and a CLOUDFRONT web ACL `a2h-<stage>-web-edge` in **us-east-1** (CloudFront requires it; ADR 0001 amendment 4, the second exception to the one-region rule, holding no data). Each has one rate-based rule: `aggregateKeyType: IP`, 5-minute window, scoped by a regular expression on the URI path (after `URL_DECODE` and `NORMALIZE_PATH`) to `/mcp`, `/pr-<n>/mcp` and their subpaths, `/.well-known/oauth-protected-resource…`, `/.well-known/oauth-authorization-server…`, `/.well-known/openid-configuration…` and `/api/auth` with its subpaths; the health paths and every other page are never counted. Over the limit: 429 (WAF's default block is 403). No `Retry-After` (WAF prefixes custom headers with `x-amzn-waf-`). Request sampling is off (a sample would keep bearer tokens and addresses, design D10); CloudWatch metrics are on. Previews create no web ACL: their MCP paths are on dev's ALB, and their web distribution gets dev's CLOUDFRONT ACL through the shared parameter. The web distribution is reached without editing `web.ts`: `attachWebAcl()` registers `$transform(sst.aws.Cdn, …)` for the Cdn named `WebCdn` (the one `sst.aws.Nextjs("Web")` creates), which sets `CdnArgs.webAclArn` (CloudFront's `webAclId`). WAF counts per web ACL across everything associated with it, so dev and all previews share one counter per address.

## Sign-in allow-list (m1-hosted-connector D7)

An SSM SecureString per stage (`allowlist.ts`): dev creates `/a2h/shared/principal-allowlist`, prod `/a2h/prod/principal-allowlist`, and every preview its own `/a2h/pr-<n>/principal-allowlist` (task 8.3 fact: a preview exists before the dev deploy of the change, and its parameter is removed with the stage by `sst remove`). The deploy writes `none` (SSM refuses empty values; `ALLOWLIST_NONE`) and `ignoreChanges: ["value"]`, so a value set afterwards is never reverted by a later deploy. Value: addresses separated by commas, or `none`. The owner sets dev's and prod's with one line (`docs/runbooks/aws-bootstrap.md` §15); on a preview the verify job adds the two QA test addresses before signing in and removes them when it ends (`.github/scripts/allowlist.sh`), and the preview comment prints the line the owner uses to add their own address.

The web server function reads it. These are `web.ts` changes (Web-dev, group 5), with the names and the permission from `config.ts`:

```ts
import { allowlistParameterName, allowlistReadPermission } from "./config.ts";
// createWeb(stage, { storage, mcpUrl, accountId }) — accountId from aws.getCallerIdentityOutput().accountId in index.ts
permissions: [
  ...store.permissions,
  // apply(): the account id is an Output
  { actions: ["ssm:GetParameter"], resources: [$interpolate`arn:aws:ssm:eu-west-3:${accountId}:parameter${allowlistParameterName(stage)}`] },
],
environment: { /* … */ ALLOWLIST_PARAMETER: allowlistParameterName(stage) },
```

(`allowlistReadPermission(stage, accountId)` gives the same statement for a plain account id.) No `kms:Decrypt`: the parameter uses the AWS-managed `aws/ssm` key, and the workload boundary already allows `ssm:GetParameter` on `/a2h/*` and `kms:Decrypt` through SSM. The Data API (design D2) needs the boundary's `A2HDataApi` statement, which the owner applies once (runbook §16).

## Hostnames (`domain` = `a2h-protocol.org`)

| Stage | Web | MCP endpoint (`mcp` output) |
|---|---|---|
| `prod` | `https://a2h-protocol.org` | `https://mcp.a2h-protocol.org/mcp` |
| `dev` | `https://dev.a2h-protocol.org` | `https://mcp.dev.a2h-protocol.org/mcp` |
| `pr-<n>` | `https://pr-<n>.dev.a2h-protocol.org` | `https://mcp.dev.a2h-protocol.org/pr-<n>/mcp` (dev's ALB) |

`hostnames()` and `publicUrls()` in `config.ts` derive them; `infra/test/domain.test.ts` asserts them for prod, dev and `pr-12`, together with the listeners, the redirect, the web domain, the SES identity and the Data API flags, by running the component functions against recording stubs of the SST globals. The deploy creates every record and certificate through `sst.aws.dns()` (Route 53 zone `a2h-protocol.org` in the A2H account): the ALB alias and its eu-west-3 certificate on dev and prod, the CloudFront alias and its us-east-1 certificate per web stage (previews included, removed with the stage), and the SES identity's DKIM CNAMEs and `_dmarc` TXT (`v=DMARC1; p=none;`, SST's default). Nothing is created by hand.

**Prod and the SES identity.** dev creates the SES domain identity for `a2h-protocol.org`. An SES identity exists once per account and region, so prod (same account, same region) cannot create a second one: before the first prod deploy, prod must reuse the identity (`Email.get`) or own it with dev reading it. Prod is not deployed in m1-hosted-connector.

## What each service receives

MCP and worker (arm64, 0.25 vCPU / 0.5 GB; MCP scales 1-2 on dev/prod, 1-1 on pr; worker 1-1):
`PORT=3000`, `STAGE`, `MCP_BASE_PATH` (`/mcp` or `/pr-<n>/mcp`), `STORAGE_PREFIX` (`dev/`, `prod/` or `pr-<n>/`), `UPLOADS_BUCKET`, `DB_SCHEMA` (`public` or `pr_<n>`), `DB_JOBS_SCHEMA` (pg-boss, design D3: `pgboss` or `pr_<n>_jobs`), `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` injected by ECS from Secrets Manager (`ssm` -> task `secrets.valueFrom` `<secretArn>:password::`; never in plain `environment`). Both services set **`wait: true`** on every stage: `sst deploy` waits for ECS steady state, so an unhealthy or crash-looping deploy fails the job.

Since m1-protocol-connector (task 6.1), every name is listed in `service-env.ts` (plain and database) and `stage-secrets.ts` (keys); `tests/ci/infra-consistency.test.sh` fails when an app reads a variable infra does not provide to that service.

| Variable | mcp | worker | Value |
|---|---|---|---|
| `PRINCIPAL_ID`, `PRINCIPAL_IDENTITY_MODE`, `PRINCIPAL_VERIFIED` | yes | yes | `dev-principal-<stage>`, `verified_organisation`, `true` (design D7, `developmentPrincipal()` in `config.ts`) |
| `PRINCIPAL_CURRENCY`, `PRINCIPAL_MONTHLY_BUDGET_MINOR`, `PRINCIPAL_PER_REQUEST_CAP_MINOR`, `PRINCIPAL_ASK_FIRST_ABOVE_MINOR`, `PRINCIPAL_DAILY_REQUEST_LIMIT`, `PRINCIPAL_THROTTLED_DAILY_LIMIT` | yes | yes | `developmentPolicy(stage)` in `config.ts` (`DEVELOPMENT_POLICY`, with the monthly budget ×10 on `dev` only), the fields of `ValidationPolicySchema` (packages/protocol); integers in minor units; `PRINCIPAL_ASK_FIRST_ABOVE_MINOR=none` means `null` (every request asks first) |
| `FEE_RATE`, `CLEARING_SHARE` | yes | yes | `f` and `s` of ADR 0002, development values (OPEN until the pre-M4 ADR) |
| `SIMULATOR_ENABLED` | no | yes | `false` on prod, `true` on dev and previews (task 5.6) |
| `SIGNING_KEY_ID`, `SIGNING_PRIVATE_KEY`, `SIGNING_PUBLIC_KEY` | no (verifies with public keys from `signing_keys`, never signs) | yes | ECS secrets from `a2h/<stage>/signing`, JSON keys `key_id`, `private_key_pkcs8` (base64 PKCS#8 DER), `public_key` (base64 raw 32 bytes) |
| `APPROVAL_KEY` | yes | no | ECS secret from `a2h/<stage>/approval`, JSON key `key` (base64 of 32 bytes; decode before `createRequestStateCodec`) |

**Per-stage keys (design D4 amendment).** `stage-secrets-resources.ts` creates, on every stage including previews, an Ed25519 key (`tls.PrivateKey`) and 32 random bytes (`random.RandomBytes`), and stores them as `a2h/<stage>/signing` and `a2h/<stage>/approval` (`aws.secretsmanager.Secret` + `SecretVersion`). Provider outputs and the secret values are secret in Pulumi state and are not stack outputs. `valueFrom` is pinned to the version the deploy wrote (`<arn>:<key>::<versionId>`), so a rotation changes the task definition and ECS replaces the tasks; a version put by hand is never picked up silently. Rotation on dev and prod: bump `STAGE_KEY_GENERATIONS` in `config.ts` (new resource name, new key, new secret version), see `docs/runbooks/aws-bootstrap.md` §14. Previews delete their secrets without a recovery window on `sst remove`, so a re-deploy of the same PR can recreate the names. Key id: `a2h-<stage>-<first 16 hex of SHA-256(raw public key)>`. The `tls` and `random` providers are declared in `sst.config.ts` at the versions SST 4.17.2 bundles (`random` 4.16.6, `tls` 5.0.1).

| | `dev`, `prod` | `pr-<n>` |
|---|---|---|
| `DB_USER` | Aurora master user (M0) | `pr_<n>` |
| `DB_PASSWORD` from | Aurora master secret (SST-managed) | `a2h/pr-<n>/db`, key `password`, looked up **by name while the program runs** (`aws.secretsmanager.getSecret`); the preview workflow creates it with `pr-schema.sh create <n>` before `sst deploy`, so a missing secret fails the deploy (and `diff`, `refresh`); only `sst remove` tolerates it, see below |
| Uploads bucket | `link` (SST least-privilege IAM, `Resource.Uploads`) | not linked; `permissions` `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on `arn:aws:s3:::<bucket>/uploads/pr-<n>/*` and `arn:aws:s3:::<bucket>/tmp/pr-<n>/*` only |
| `Email` | linked when it exists | linked when it exists |
| Execution role (ECS agent) | `secretsmanager:GetSecretValue` on the Aurora master secret ARN, and on the ARN of this service's own stage secret: `a2h/<stage>/signing` (worker) or `a2h/<stage>/approval` (mcp) | `secretsmanager:GetSecretValue` on `arn:aws:secretsmanager:eu-west-3:<account>:secret:a2h/pr-<n>/db-*`, and on the ARN of this service's own stage secret: `a2h/pr-<n>/signing` (worker) or `a2h/pr-<n>/approval` (mcp) |

The mapping is pure and unit-tested (`access.ts`, `infra/test/access.test.ts`): user and secret names, `valueFrom` exactly `<arn>:password::`, `DB_PASSWORD` never in `environment`, a pr stage refuses the master source and any secret other than its own `a2h/pr-<n>/db`, the two S3 object ARNs, and the execution role policy.

**Execution role, narrowed.** SST's default Fargate execution role (`fargate.ts` `createExecutionRole`) carries an inline policy `ReadSsmAndSecrets` with `ssm:GetParameters`, `ssm:GetParameter`, `ssm:GetParameterHistory` and `secretsmanager:GetSecretValue` on `*`. `containerConfig()` in `mcp.ts` passes `transform.executionRole` (object form, merged over SST's arguments) to replace that inline policy with `executionRolePolicy()` from `access.ts`: `secretsmanager:GetSecretValue` on the secret `DB_PASSWORD` comes from and, by exact ARN, on the stage secrets this service receives (statement `ReadStageSecrets`). No SSM action: the task's `secrets` entries all come from Secrets Manager (SST's `link` values go to Docker build secrets, not to the task definition), and nothing uses `environmentFiles`. No `kms:Decrypt`: every secret uses the AWS-managed `aws/secretsmanager` key. The managed `AmazonECSTaskExecutionRolePolicy` (ECR pull, CloudWatch Logs) and the permissions boundary stay. pr stages grant by name pattern (`a2h/pr-<n>/db-*`, account from `aws.getCallerIdentityOutput()`), not by the looked-up ARN, so the grant survives a re-created secret and does not depend on the lookup.

**`sst remove` without the secret.** `a2h/pr-<n>/db` is absent for a PR that never deployed and for a teardown re-run after `pr-schema.sh drop`. `sst.config.ts` passes SST's `$cli.command` to `deploy()`; `previewDbCredentials()` (`access.ts`, unit-tested) tolerates a missing or unreadable secret only when that command is exactly `remove`, and then gives the task no password reference at all (`ssm` empty). Every other command still fails, naming the secret and `pr-schema.sh create`; a secret that *is* found is still checked against `a2h/pr-<n>/db` on remove. The execution-role grant is built from the name pattern and the account, so it needs no lookup either. What SST 4.17.2 does on remove (read in `pkg/project/run.go` at tag `v4.17.2` and in the 4.17.2 binary): it builds `sst.config.ts` with esbuild and defines `$cli` as `{ command: input.Command, dev, paths, state }` (`"remove"` from `cmd/sst/remove.go`), then runs `pulumi destroy --yes -f` **without** `--run-program` (only `refresh` passes it). So by default the program is not evaluated on remove and the lookup never runs; it is evaluated when `PULUMI_RUN_PROGRAM=true` is in the environment (SST passes `os.Environ()` through to Pulumi) or if a later SST adds `--run-program` to destroy. The tolerance covers those cases. `readShared()` still needs dev's SSM parameters if the program does run.

**Why pr stages do not use `Aurora.get`:** in SST 4.17.2, `Aurora.get` (`.sst/platform/src/components/aws/aurora.ts`, `reference()`) calls `secretsmanager.getSecretVersionOutput` on the master secret to fill its `password` property. That would read the master password into every preview's state and require the preview role to read it. `pr-*` takes host, port and database name from `aws.rds.getClusterOutput` instead, which returns no credential.

**Database credentials, why not `link`:** SST's `link` on a Fargate service writes every linked property, including the Aurora password, into the task definition's plain `environment`. Injecting the secret through `ssm` keeps the password out of the task definition and out of `environment`; the app-side adapter (`apps/*/infra/`, step 5) composes `DATABASE_URL` in process and sets `search_path` to `DB_SCHEMA` only.

Web (`sst.aws.Nextjs`, Node 22, arm64, 1024 MB, 20 s, `warm` 1 on dev/prod and 0 on pr, no `regions`, `openNextVersion` pinned to `OPEN_NEXT_VERSION` = 4.1.12 in `config.ts` because SST 4.17.2's default OpenNext 3.9.14 refuses Next 15.5.x): `STAGE`, `DB_SCHEMA`, `STORAGE_PREFIX`, `MCP_URL`, `UPLOADS_BUCKET`; storage as in the table above (dev/prod `link` to `Uploads`; pr the same three object permissions on the server function's role, no link). Web is created only when `apps/web` contains `next.config.{ts,mjs,js}`; until then the `web` output reads "not deployed (apps/web has no Next.js app yet)". Step 5 adds the app; nothing here changes.

Storage keys: `<tmp|uploads>/<STORAGE_PREFIX><key>` with `STORAGE_PREFIX` `dev/`, `prod/` or `pr-<n>/` (`STORAGE_AREAS` in `config.ts`, shared by the lifecycle rules and the preview grants). Every stage has a prefix and none is a prefix of another, so a preview's grant on `uploads/pr-<n>/*` can never reach a `dev` object (a dev key is `uploads/dev/…`, never `uploads/pr-<n>/…`; tested in `infra/test/access.test.ts` and `config.test.ts`). The lifecycle rules sit at the area roots (`tmp/` 7 days, `uploads/` `UPLOAD_RETENTION_DAYS` = 180; `lifecycleRules()` in `storage.ts`) and so cover every stage's objects (`infra/test/storage.test.ts`).

## Permissions boundary on every workload role

`sst.config.ts` `run()` registers `$transform(aws.iam.Role, …)` **before** `infra/index.ts` is imported. It sets `permissionsBoundary` to `arn:aws:iam::<account>:policy/a2h-workload-boundary` (`WORKLOAD_BOUNDARY_POLICY_NAME` and `workloadBoundaryArn()` in `config.ts`, unit-tested), with the account from `aws.getCallerIdentityOutput()`. The policy is created by the bootstrap (`infra/bootstrap/`); the deploy roles may create or modify `role/a2h-*` only when it is attached.

How it reaches roles inside components (checked in the 4.17.2 sources): `$transform` on a non-`sst:` type calls Pulumi `runtime.registerStackTransformation` (`.sst/platform/src/components/component.ts`). Pulumi's `Resource` constructor copies its parent's transformations, falling back to the stack's, at construction time (`@pulumi/pulumi/resource.js`). So every `aws.iam.Role` created by a component constructed after registration gets the boundary, including roles created later inside `.apply()`. A component constructed before registration would not pass it to its children; this is why the transform comes first.

Role-creating sites in the components this app uses:

| Component (file:line in `.sst/platform/src/components/aws/`) | Role | Created here? | Boundary |
|---|---|---|---|
| `Service` → `fargate.ts:991` `createTaskRole` | `<Svc>TaskRole` | yes, MCP and worker, every stage | covered |
| `Service` → `fargate.ts:1023` `createExecutionRole` | `<Svc>ExecutionRole` | yes, MCP and worker, every stage | covered |
| `Nextjs` → `ssr-site.ts:1466` server `Function` → `function.ts:2274` | `WebServerEuwest3Role` | yes, once `apps/web` has a Next.js app | covered |
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

## IAM role names

The same `$transform(aws.iam.Role, …)` sets `name` on every role this app creates to `roleName($app.stage, <logical name>)` (`infra/config.ts`, tested in `infra/test/role-name.test.ts`): `a2h-<stage>-<readable>-<hash>`, at most 64 characters. `<stage>` is kept whole; `<readable>` is the logical name with non-alphanumerics removed, cut to fit; `<hash>` is the first 8 hex characters of SHA-256 over the full logical name, so names that share a long prefix, or differ only in dropped characters or in case (IAM compares role names case-insensitively), stay distinct. No random part: the same stage and logical name always give the same role name.

Why: SST names roles with `physicalName(64, …)` (`naming.ts` `prefixName`, applied by `component.ts:259`). When the logical name plus the stage does not fit, it drops or truncates the app prefix. The Next.js revalidation subscriber role (`nextjs.ts:866-878` → `queue.ts:598-601` → `queue-lambda-subscriber.ts:62` → `function.ts:2274`), logical name `WebRevalidationEventsSubscriber<6 chars>FunctionRole` (49 characters), came out as `a-dev-…`, `prod-…` or `pr-12-…`, which the deploy roles may not create (`role/a2h-*` only).

Who wins (checked in the 4.17.2 sources): SST sets a default `name` in a transformation registered on each component (`component.ts:66-403`; the role rule is line 259, the "already set" check line 368), and only when `name` is unset. Pulumi runs a resource's own transformations, then its parent's, which already include the component chain and then the stack's (`@pulumi/pulumi/resource.js:180`, `[...opts.transformations, ...parent.__transformations]`). So SST's default runs first and this stack transformation overwrites it. Component `transform.*` arguments (such as `transform.executionRole` in `mcp.ts`) are applied before the resource is constructed, so they run before both. SST's own stack transformations (`auto/run.ts`, `link.ts`) are registered before `run()` and do not touch role names. Only a `$transform(aws.iam.Role, …)` registered after this one could override it; there is none, and there must not be.

Computed names for the longest stage, `pr-19899`, and the longest logical name:

| Logical name | Role name |
|---|---|
| `McpPr19899TaskRole` | `a2h-pr-19899-McpPr19899TaskRole-a39afb69` |
| `WorkerPr19899ExecutionRole` | `a2h-pr-19899-WorkerPr19899ExecutionRole-34937101` |
| `WebRevalidationEventsSubscriberXkzrmsFunctionRole` | `a2h-pr-19899-WebRevalidationEventsSubscriberXkzrmsFunct-e3173c96` (64) |

**Changing a role's name replaces the role.** For roles that SST names by default, SST also adds `ignoreChanges: ["name"]` (`component.ts:400`), so a changed `roleName()` would instead be ignored for roles already deployed and applied only to new ones: the function would no longer describe what is deployed. Either outcome is unacceptable once a stage exists. Nothing is deployed yet, so this rename is free now; after the first deploy, `roleName()` and its pinned test values must never change without a migration note (which roles, replace or keep, and how running tasks and functions move to the new role).

## Residual risks (M0, accepted; documented by the PM in `docs/runbooks/aws-bootstrap.md`)

- **`dev` still uses the Aurora master user.** Its services log in as the master user and can reach every `pr_<n>` schema. Only `pr-*` stages have their own login. A per-stage login for `dev` is a later change.
- **The preview deploy role can still modify `dev` resources.** `gha-a2h-preview` has PowerUser-level rights (bounded by the `role/a2h-*` + boundary condition for IAM), and `dev` and `pr-*` share one account, VPC, cluster, ALB, Aurora cluster and bucket. A malicious PR branch that edits `infra/` runs with that role. The scoped storage grant and the per-PR login limit what a preview's *runtime* can touch, not what its *deploy* can.

## Outputs (`.sst/outputs.json`)

`stage`, `web`, `mcp` (ALB base URL + `MCP_BASE_PATH`), `albUrl`; on `dev` also `shared` (the nine identifiers).

## Typecheck and tests without AWS credentials

`pnpm typecheck` runs `sst install` (downloads the pinned providers and generates the gitignored `.sst/platform/config.d.ts`; no cloud access) and then `tsc` on `infra/*.ts` and `sst.config.ts`. tsc also reads SST's own `.ts` sources, so `infra/tsconfig.json` turns off four flags those sources do not satisfy (`verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`); `strict` stays on. `pnpm test` runs `infra/test/config.test.ts` (stage model, priorities and the two preview bands, SSM names, idle timeout, boundary ARN, pr reads, health-path and metadata-path agreement, stage limits, allow-list names) `infra/test/role-name.test.ts` (role names: `a2h-<stage>-` prefix, 64-character limit, uniqueness, stability) `infra/test/access.test.ts` (per-PR login, valueFrom, scoped storage ARNs, execution role policy, the remove-time secret decision) and `infra/test/storage.test.ts` (lifecycle rules cover every stage's prefix), `infra/test/stage-secrets.test.ts` (secret names, Ed25519 and 32-byte formats importable by packages/protocol, key id, pinned valueFrom, per-service grants, generations) and `infra/test/service-env.test.ts` (the policy environment round-trips to packages/protocol's `ValidationPolicySchema` and `PrincipalSchema`, `DB_JOBS_SCHEMA`, `SIMULATOR_ENABLED`, names per service, limits and the issuer and resource URLs per stage) `infra/test/bootstrap-policies.test.ts` (the boundary allows the Data API on `a2h-*` clusters and the allow-list read, no IAM or bare wildcard in either bootstrap policy, PowerUserAccess covers the deploy-time calls) and `infra/test/edge.test.ts` (the WAF rule: paths in and out of scope, health excluded, limit, per-address key, 429; the web ACLs per stage kind, the us-east-1 provider, the ALB association, the `WebCdn` transform; the allow-list parameter) with `node --test`. No SST synth or diff runs without AWS credentials: the Pulumi resources themselves (tls, random, Secrets Manager) are exercised only by a deploy.
