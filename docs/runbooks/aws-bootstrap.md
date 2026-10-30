# Runbook: AWS bootstrap (one time, performed by the product owner)

This runbook lists every manual step that must happen once before CI can deploy A2H to AWS. Agents never deploy (CLAUDE.md); after this runbook, every deployment is a GitHub Actions run that assumes an IAM role through OIDC. Nothing here is executed by an agent.

Read with: `docs/decisions/0001-stack-and-hosting.md` (what gets deployed), `infra/README.md` (stage model, shared resources, SSM contract), `.github/workflows/*.yml` (what CI does with the role), `openspec/changes/m0-foundation/tasks.md` §Step 4 (the contract between infra and CI).

## 0. Where A2H lives (decided 2026-10-25)

A2H has its own AWS account, created by the owner as a member of the organisation `o-oow2nzdkfh` whose management account (`725960317785`) hosts another project. Agents never create accounts. The PM runs §1, §3, §4 and §7 with the owner's approval; the owner runs §2.

| Item | State on 2026-10-25 |
|---|---|
| A2H account | `442123849268` (`a2h`, root email is the owner's `+a2h` alias), home region `eu-west-3` |
| Access from this machine | CLI profile `a2h-member` assumes `arn:aws:iam::442123849268:role/OrganizationAccountAccessRole` from profile `a2h` (the management-account IAM user `galem`). No key exists for the member account. |
| GitHub OIDC provider | None yet in `442123849268` (§3 creates it; the one in the management account belongs to the other project) |
| SES (eu-west-3) | Sandbox, sending enabled, no identity |
| SST state / bootstrap buckets, RDS, budgets | None yet |
| IAM Identity Center / SCPs | Not enabled |

Why a separate account: the CI deploy roles hold PowerUser rights across whatever account they live in (§3, residual risks). In a dedicated account that reach ends at A2H's own resources.

## 1. Account hygiene (10 minutes)

1. Root user has MFA. Check in IAM → Dashboard → Security recommendations.
2. Create a monthly cost budget with an email alert. Replace the amount if you prefer another ceiling (AWS cost budgets are in USD only):

```sh
aws budgets create-budget --profile a2h-member --account-id 442123849268 \
  --budget '{"BudgetName":"a2h-monthly","BudgetLimit":{"Amount":"80","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"galem+a2h@holostaff.ai"}]}]'
```

Approximate steady cost of the `dev` stage while idle (eu-west-3 list prices, no reserved capacity): one ALB about €18/month, two Fargate tasks (0.25 vCPU / 0.5 GB, arm64) about €16/month, Aurora Serverless v2 at 0 ACU when idle about €0 plus storage, CloudMap €0.50, CloudFront/Lambda/S3 near zero at M0 traffic. Each open preview adds two more tasks (Fargate Spot) for as long as the PR is open. There is no NAT gateway: the Fargate tasks run in public subnets with public IPs and the VPC default security group, which is SST's default (see `infra/README.md` and the open items in the step-4 PR).

## 2. Rotate the bootstrap access key (do this now, 5 minutes)

The access key of IAM user `galem` was pasted in a chat and must be treated as exposed. Rotate it before anything else, not after this PR is reviewed.

```sh
aws iam list-access-keys --profile a2h --user-name galem      # note the current key id
aws iam create-access-key --profile a2h --user-name galem      # note the new pair
aws configure --profile a2h                                     # paste the new pair, region eu-west-3, output json
aws sts get-caller-identity --profile a2h                       # confirms the new key works
aws iam update-access-key --profile a2h --user-name galem --access-key-id <old key id> --status Inactive
aws iam delete-access-key --profile a2h --user-name galem --access-key-id <old key id>
```

After §7 succeeds, downgrade this user (§10). Long-term, prefer IAM Identity Center (`aws sso login`) over access keys for humans.

## 3. Create the boundary and the two deploy roles (15 minutes)

The OIDC provider exists already (§0). The policies are in `infra/bootstrap/` so they are reviewed like code. IAM Access Analyzer `validate-policy` reported no findings on them on 2026-10-21, apart from the preview trust's wildcard-subject warning explained below.

| Role | Who can assume it | Used by |
|---|---|---|
| `gha-a2h-dev` | Workflows running on `main` only (subject `repo:xxl007@232548/a2h@1428197596:ref:refs/heads/main`) | `deploy.yml` (push to `main`, and the manual first deploy) |
| `gha-a2h-preview` | Workflows triggered by a pull request of this repository (subject `repo:xxl007@232548/a2h@1428197596:pull_request`) | `preview.yml`, `teardown.yml` |

The subjects carry the owner and repository IDs because `xxl007/a2h` was created after 15 July 2026, when GitHub switched new repositories to immutable OIDC subjects (`repo:OWNER@OWNER-ID/REPO@REPO-ID:…`). The first deploy on 2026-10-25 failed with "Not authorized to perform sts:AssumeRoleWithWebIdentity" on the legacy subject; a rename or transfer of the repository keeps the IDs, so the trust policies survive it.

```sh
# 0. GitHub's OIDC provider (AWS verifies GitHub through its trusted CAs; the thumbprint is the documented fallback).
aws iam create-open-id-connect-provider --profile a2h-member \
  --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1

# 1. The ceiling every role SST creates must carry: no IAM, no role assumption.
aws iam create-policy --profile a2h-member --policy-name a2h-workload-boundary \
  --policy-document file://infra/bootstrap/a2h-workload-boundary.json \
  --description "Permissions boundary for every a2h-* workload role created by SST"

# 2. The two deploy roles. Their names start with gha-, so they can never touch themselves.
for r in dev preview; do
  aws iam create-role --profile a2h-member --role-name gha-a2h-$r \
    --assume-role-policy-document file://infra/bootstrap/gha-a2h-$r-trust.json \
    --max-session-duration 7200
  aws iam attach-role-policy --profile a2h-member --role-name gha-a2h-$r \
    --policy-arn arn:aws:iam::aws:policy/PowerUserAccess
  aws iam put-role-policy --profile a2h-member --role-name gha-a2h-$r \
    --policy-name a2h-sst-iam --policy-document file://infra/bootstrap/gha-a2h-deploy-iam.json
done

aws iam get-role --profile a2h-member --role-name gha-a2h-dev     --query Role.Arn --output text
aws iam get-role --profile a2h-member --role-name gha-a2h-preview --query Role.Arn --output text
```

Why this shape:

- `PowerUserAccess` covers everything SST creates (S3, ECR, ECS, ELB, RDS, SES, SSM, Secrets Manager, CloudFront, Lambda, DynamoDB, SQS, CloudWatch, Route 53, ACM) but no IAM.
- The inline policy adds IAM only for roles named `a2h-*`, which `sst.config.ts` enforces for every role it creates (`a2h-<stage>-<readable>-<hash>`, at most 64 characters; SST's own naming drops the prefix for long names, see `infra/README.md`). It may create or change those roles **only if they carry the boundary** `a2h-workload-boundary`. It may attach only the four AWS managed policies SST uses (ECS task execution, Lambda basic, Lambda VPC access, Lambda durable execution). It can pass roles only to ECS tasks and Lambda. It can never remove a boundary, edit the boundary policy, touch the `gha-*` roles, assume any other role, or use IAM Identity Center, Organizations or account settings.
- The boundary caps every workload role at A2H's own resources: S3, SQS, DynamoDB and Lambda named `a2h-*`, secrets named `a2h-*` (SST's own naming, for example the Aurora master secret `a2h-dev-DatabaseProxySecret-…`) or `a2h/*` (the per-PR logins), parameters under `/a2h/` and `/sst/`. Beyond that it allows only runtime plumbing: logs, image pull from SST's `sst-asset` repository, KMS decryption only through Secrets Manager, S3, SQS and SSM, network interfaces, SES sending from this account's identities, CloudFront invalidation for Next.js revalidation, and Transcribe. It never allows IAM or role assumption. ECS Exec (`ssmmessages`) is deliberately not allowed, so shell access to running containers is off.

**Residual risks: read before you approve. This account also hosts another project.**

1. **Both deploy roles hold `PowerUserAccess` across the whole A2H account.** A workflow on `main` (dev role) or in a same-repository pull request (preview role) can read and change any non-IAM resource in it. Since 2026-10-25 that account holds nothing but A2H, which is why it was separated from the other project. That includes replacing the code of the other project's Lambda functions or ECS tasks, and so acting with that project's roles. The policies above close the direct IAM routes, but they cannot close this indirect one while two projects share an account.
2. **A pull request can create a role under the boundary that trusts an outside account.** The boundary limits such a role to A2H's own data, which includes the Aurora master secret. It could also send email as any SES identity verified in this account and invalidate any CloudFront distribution in it.
3. **The preview trust cannot be pinned to a branch**, because GitHub's pull-request token carries no branch. Access Analyzer warns about exactly this.
4. **The `dev` stage connects to Postgres as the master user**, which previews do not (see `infra/README.md`). A dedicated application role is a task for the first database change in M1.
5. **Choosing an EC2 NAT instance or a bastion later** (`infra/vpc.ts`) would need `iam:CreateInstanceProfile` and the `AmazonSSMManagedInstanceCore` policy added.

**Done on 2026-10-25: A2H has its own account (§0).** For the record, the reasoning was: Use AWS Organizations, which is free: create a member account "a2h" from this one, then run this runbook in the new account. That turns risks 1 and 2 into "can affect A2H only". The cost is about 30 minutes: one email address, an `OrganizationAccountAccessRole`, a new CLI profile, and a new GitHub OIDC provider in the new account (`aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com`). Then replace `442123849268` in `infra/bootstrap/*.json` and in the commands of this runbook with the new account ID. If you keep the shared account for M0, record that choice when you approve the PR.

Session length: `sst deploy` of a fresh stage with two arm64 container builds under emulation takes 10 to 30 minutes. The 2-hour maximum session is headroom.

## 4. GitHub repository variables (5 minutes)

Needs `gh` 2.31 or later for `gh variable` (`gh --version`; this machine had 2.18.1 on 2026-10-21, upgrade with your package manager).

These are variables, not secrets. No AWS key exists anywhere in GitHub, which is what the `preview-environments` spec scenario "Secrets inventory" checks.

```sh
gh variable set AWS_DEV_ROLE_ARN     --repo xxl007/a2h --body "arn:aws:iam::442123849268:role/gha-a2h-dev"
gh variable set AWS_PREVIEW_ROLE_ARN --repo xxl007/a2h --body "arn:aws:iam::442123849268:role/gha-a2h-preview"
gh variable list --repo xxl007/a2h
gh secret list --repo xxl007/a2h          # must list no AWS_* entry
```

Leave `A2H_DEPLOY_ENABLED` unset for now: the deploy jobs skip themselves until it is `true` (§7).

**Branch protection is not available on this plan.** For a private repository on a GitHub Free personal account, the API returns 403 ("Upgrade to GitHub Pro or make this repository public"); the cold reviewer checked this on 2026-10-21. Rulesets have the same limit. Without it, nothing technically stops a merge with red CI. The preview and `dev` deploys still require a green `check` in their own run. Options are listed in the step-4 PR under "Decide first". If you choose GitHub Pro or a public repository, run:

```sh
gh api -X PUT repos/xxl007/a2h/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{"required_status_checks":{"strict":true,"contexts":["check"]},"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null,"allow_force_pushes":false,"allow_deletions":false}
JSON
```

## 5. Merge the step-4 PR

With `A2H_DEPLOY_ENABLED` unset, merging deploys nothing. CI runs lint, typecheck, tests and the workflow checks only.

## 6. SST state and passphrase: what the first deploy creates

The first `sst deploy` bootstraps the account: an S3 bucket `sst-state-<hash>` (state), `sst-asset-<hash>` (assets), an ECR repository `sst-asset`, SSM parameters under `/sst/bootstrap` and `/sst/passphrase/a2h/<stage>`. **Never delete the passphrase parameters**: without them the state cannot be read and the stage cannot be updated or removed. `sst remove` does not delete them either.

## 7. First deployment of the `dev` stage (30 minutes, mostly waiting)

```sh
gh variable set A2H_DEPLOY_ENABLED --repo xxl007/a2h --body true
gh workflow run deploy.yml --repo xxl007/a2h --ref main
gh run watch --repo xxl007/a2h            # pick the deploy run
```

When it finishes, verify from your machine (read-only):

```sh
aws ssm get-parameters-by-path --profile a2h-member --path /a2h/shared/ --query 'Parameters[].[Name,Value]' --output table
aws ecs list-services --profile a2h-member --cluster "$(aws ssm get-parameter --profile a2h-member --name /a2h/shared/cluster-id --query Parameter.Value --output text)" --output table
ALB_ARN=$(aws ssm get-parameter --profile a2h-member --name /a2h/shared/alb-arn --query Parameter.Value --output text)
ALB_DNS=$(aws elbv2 describe-load-balancers --profile a2h-member --load-balancer-arns "$ALB_ARN" --query 'LoadBalancers[0].DNSName' --output text)
curl -si "http://$ALB_DNS/healthz" | head -1                                           # expect HTTP/1.1 200
aws elbv2 describe-load-balancer-attributes --profile a2h-member --load-balancer-arn "$ALB_ARN" \
  --query "Attributes[?Key=='idle_timeout.timeout_seconds'].Value" --output text      # expect 3600
for r in $(aws iam list-roles --profile a2h-member --query "Roles[?starts_with(RoleName, 'a2h-')].RoleName" --output text); do
  printf '%s\t' "$r"; aws iam get-role --profile a2h-member --role-name "$r" --query Role.PermissionsBoundary.PermissionsBoundaryArn --output text
done   # every line must end in policy/a2h-workload-boundary (ListRoles never returns the boundary; GetRole does)
aws iam list-roles --profile a2h-member --query "Roles[?starts_with(RoleName, 'a2h-')].[RoleName, PermissionsBoundary.PermissionsBoundaryArn]" --output table   # every row must show a2h-workload-boundary
```

If the deploy fails with `AccessDenied` on `iam:CreateRole`, a role was created without the boundary: send the PM the run URL; do not widen the policy by hand. If the ECS services report "deployment circuit breaker: tasks failed to start", read the stopped task's reason (`aws ecs describe-tasks`) before anything else; on 2026-10-25 it was the boundary denying the Aurora secret, fixed by boundary version v2, after which `aws ecs update-service --force-new-deployment` on both services restarted them because a tripped circuit breaker does not retry on its own.

The eight `/a2h/shared/*` parameters are what every `pr-<n>` stage reads; if they are missing, previews cannot deploy. From now on every pull request from this repository gets a preview and a comment with its URLs; closing it tears the stage down, then drops its schema, its database login and its secret.

Also make the Postgres read-only role for the `postgres-readonly` MCP server (see `docs/runbooks/mcp-setup.md`) once you want agents to inspect data. It is not needed for M0.

## 8. Domain and TLS (done 2026-10-30)

The domain is **`a2h-protocol.org`** (proposal `m1-hosted-connector`, decision 1). Hosted MCP clients such as claude.ai require HTTPS, which is why the domain comes before any external agent connects.

Done by the owner:

1. Registered `a2h-protocol.org` in Route 53 in the A2H account (dedicated account, profile `a2h-member`); Route 53 created its public hosted zone. The delegation became visible on public resolvers at 01:30 UTC on 2026-10-30. To check it at any time (read-only):

   ```sh
   dig +short NS a2h-protocol.org @8.8.8.8          # expect the four awsdns name servers of the zone
   aws route53 list-hosted-zones-by-name --profile a2h-member --dns-name a2h-protocol.org --max-items 1
   ```

2. `domain = "a2h-protocol.org"` in `infra/config.ts` (PR for task 1.2 of `m1-hosted-connector`). Hostnames per stage: `infra/README.md`, "Hostnames".

What the first `dev` deploy after that merge creates, all through `sst.aws.dns()` in the zone, nothing by hand:

- an ACM certificate in eu-west-3 for `mcp.dev.a2h-protocol.org`, DNS-validated, on a new HTTPS listener (443) of dev's ALB; the HTTP listener (80) now answers 301 to HTTPS; an alias record `mcp.dev.a2h-protocol.org` -> ALB;
- an ACM certificate in **us-east-1** for `dev.a2h-protocol.org` on the CloudFront distribution of the web app, and its alias record (ACM in us-east-1 is the single exception to the one-region rule, ADR 0001; it holds no data);
- the SES identity and its records (§9).

Certificate issuance waits for DNS validation, so that deploy takes several minutes longer than usual. Each preview (`pr-<n>`) then creates its own us-east-1 certificate and `pr-<n>.dev.a2h-protocol.org` record, removed with the stage; its MCP endpoint is `https://mcp.dev.a2h-protocol.org/pr-<n>/mcp` on dev's certificate. Prod (`a2h-protocol.org`, `mcp.a2h-protocol.org`) is derived but not deployed.

Verify after the dev deploy (read-only):

```sh
curl -sI http://mcp.dev.a2h-protocol.org/mcp | sed -n '1p;/^[Ll]ocation/p'   # expect 301 and Location: https://mcp.dev.a2h-protocol.org:443/mcp
curl -s https://mcp.dev.a2h-protocol.org/healthz                            # expect the health answer, certificate accepted
curl -sI https://dev.a2h-protocol.org | head -1                             # expect HTTP/2 200
```

Rollback: set `domain` back to `undefined` and merge; the ALB returns to HTTP on its AWS hostname.

## 9. Email: SES identity and production access

Sandbox is enough until real participants receive mail: you can send to verified addresses only (your own), 200 per day.

1. **Identity (done by the deploy).** `emailSender` in `infra/config.ts` is the domain, `a2h-protocol.org`. The first dev deploy after the task 1.2 merge creates the SES **domain** identity in eu-west-3, its three DKIM CNAME records and a `_dmarc.a2h-protocol.org` TXT record `v=DMARC1; p=none;` (SST's default) in the zone. SES verifies the identity on its own once it sees the DKIM records, usually within minutes, at most 72 hours. Check (read-only):

   ```sh
   aws sesv2 get-email-identity --profile a2h-member --region eu-west-3 --email-identity a2h-protocol.org \
     --query '{verified: VerifiedForSendingStatus, dkim: DkimAttributes.Status}'   # expect verified true, dkim SUCCESS
   dig +short TXT _dmarc.a2h-protocol.org @8.8.8.8                                # expect "v=DMARC1; p=none;"
   ```

   The identity belongs to dev. Prod shares the account and region, where an identity exists once: before the first prod deploy, prod reuses it (see `infra/README.md`, "Prod and the SES identity").

2. **Production access (you, once the identity is verified).** Magic links on prod need it; dev and previews use a mail sink in this change, so nothing waits for the answer. Console: **Amazon SES** (region **Europe (Paris) eu-west-3**) > **Account dashboard** > **Request production access**; mail type *Transactional*, website `https://a2h-protocol.org`, and the use case below. Or from your shell:

```sh
aws sesv2 put-account-details --profile a2h-member --region eu-west-3 \
  --production-access-enabled \
  --mail-type TRANSACTIONAL \
  --website-url https://a2h-protocol.org \
  --use-case-description "A2H sends transactional email only: sign-in links to principals and participants who created an account, and notifications (request summaries, decline links, answer notifications, payout notices) to participants who opted in. Bounces and complaints are processed through SES event notifications and suppress the address." \
  --additional-contact-email-addresses <your email> \
  --contact-language EN
aws sesv2 get-account --profile a2h-member --region eu-west-3 --query '{production: ProductionAccessEnabled, review: Details.ReviewDetails}'   # status of the request
```

AWS answers within about a day (at most 96 hours). Note the case id from the confirmation email in `openspec/changes/m1-hosted-connector/tasks.md`, task 1.1.

## 10. Downgrade the local IAM user (after §7)

Replace `AdministratorAccess` on `galem` with read-only plus what the agents' MCP servers need (CloudWatch Logs Insights). Agents never deploy, so no human key needs write access after bootstrap.

```sh
aws iam detach-user-policy --profile a2h --user-name galem --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
aws iam attach-user-policy --profile a2h --user-name galem --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess
aws iam put-user-policy --profile a2h --user-name galem --policy-name a2h-logs-insights \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["logs:StartQuery","logs:GetQueryResults","logs:StopQuery"],"Resource":"*"}]}'
```

Keep a break-glass path (root with MFA, or a second admin user without keys) for the rare manual change.

## 11. Stripe (M4, not now)

Setting SST secrets writes to the state bucket, so it needs write access that §10 removes from your user. Use a short admin session (for example IAM Identity Center) for this step.

Test mode only until you say otherwise (CLAUDE.md). When the M4 change lands, its proposal names the secrets; you set them with the SST CLI from your machine (this writes encrypted values to the state bucket, it does not deploy):

```sh
pnpm exec sst secret set StripeSecretKey sk_test_... --stage dev
pnpm exec sst secret set StripeSecretKey sk_test_... --fallback      # used by pr-* stages that have no value of their own
```

Secrets never enter the repository, `.env` files are gitignored, and workflow logs mask them.

## 12. If a deploy is interrupted: state lock

SST locks a stage's state during `deploy` and `remove`. The workflows never cancel a running deploy, but a runner timeout or a manual cancel can leave the lock behind, and the next run for that stage then fails with a lock error. From your machine:

```sh
pnpm exec sst unlock --stage pr-<n>     # or --stage dev
```

Then re-run the failed workflow from the Actions tab. Only unlock when no run for that stage is in progress.

## 13. Report back

Tell the PM: the two role ARNs, that the key was rotated, that the variables are set, the boundary check from §7, the `deploy.yml` run URL, the eight SSM parameters, the `healthz` result, and your decisions on the items under "Decide first" in the step-4 PR. Step 5 (hello world, GATE 2) starts after that.

## 14. Signing and approval keys per stage (M1; nothing to do to bring a stage up)

Every stage has two secrets of its own, created by the deploy itself (`sst deploy`, `infra/stage-secrets-resources.ts`; design D4 amendment of `openspec/changes/archive/2026-10-29-m1-protocol-connector`):

| Secret | Holds | Read by |
|---|---|---|
| `a2h/<stage>/signing` | The platform's Ed25519 key that signs answers: `key_id`, `private_key_pkcs8`, `public_key` (JSON). The key is generated by the deploy (Pulumi `tls` provider) | worker only (`SIGNING_KEY_ID`, `SIGNING_PRIVATE_KEY`, `SIGNING_PUBLIC_KEY`) |
| `a2h/<stage>/approval` | The HMAC key that protects a pending approval between the elicitation and the retry: 32 random bytes (Pulumi `random` provider), JSON key `key` | mcp only (`APPROVAL_KEY`) |

**Bringing a stage up: nothing to do.** `dev` gets its secrets on the first deploy that includes this change; every preview gets fresh ones when it is created and loses them when it is torn down (deleted at once, no recovery window). Nobody creates, copies or reads key material by hand, the values are secret in the SST state and never appear in outputs or logs, and `pr-schema.sh` still creates only `a2h/pr-<n>/db`. `prod` gets its own the day `prod` is first deployed (no workflow deploys it yet).

**No IAM change for you to apply.** The deploy roles hold `PowerUserAccess` (§3), which covers creating, updating and deleting these secrets; the workload boundary already allows `secretsmanager:GetSecretValue` on `a2h/*`; and each service's execution role is narrowed by `infra/` to its own stage's secrets, by ARN. `tests/ci/bootstrap.test.mjs` checks both facts against `infra/bootstrap/`.

Check a stage's secrets after a deploy (read-only; shows names, dates and version ids, never a value):

```sh
STAGE=dev
for KIND in signing approval; do
  aws secretsmanager describe-secret --profile a2h-member --region eu-west-3 --secret-id "a2h/$STAGE/$KIND" \
    --query '{Name: Name, Created: CreatedDate, Versions: VersionIdsToStages}' --output json
done
```

The running tasks are pinned to the version the deploy wrote: each `valueFrom` ends in a version id, and it must be the one marked `AWSCURRENT` above.

```sh
CLUSTER=$(aws ssm get-parameter --profile a2h-member --region eu-west-3 --name /a2h/shared/cluster-id --query Parameter.Value --output text)
for SERVICE in $(aws ecs list-services --profile a2h-member --region eu-west-3 --cluster "$CLUSTER" --query 'serviceArns[]' --output text); do
  TASKDEF=$(aws ecs describe-services --profile a2h-member --region eu-west-3 --cluster "$CLUSTER" --services "$SERVICE" \
    --query 'services[0].taskDefinition' --output text)
  echo "$SERVICE"
  aws ecs describe-task-definition --profile a2h-member --region eu-west-3 --task-definition "$TASKDEF" \
    --query "taskDefinition.containerDefinitions[0].secrets[?starts_with(name, 'SIGNING_') || name == 'APPROVAL_KEY'].[name, valueFrom]" \
    --output text
done
```

### Rotating the signing key (`a2h/<stage>/signing`)

When: on a schedule you choose, when someone who could read the secret leaves, or at once if you suspect the key leaked.

1. Ask the PM for a one-line PR that raises `STAGE_KEY_GENERATIONS.dev.signing` in `infra/config.ts` by one (for prod, `STAGE_KEY_GENERATIONS.prod.signing`; never lower a number). Merging it is the approval.
2. The deploy from `main` generates a new key, writes it as a new version of `a2h/dev/signing` with a new `key_id` (`a2h-dev-` followed by 16 hex characters of the new public key's hash), and replaces the worker tasks, because their `valueFrom` names the new version. Watch it:

```sh
gh run list --repo xxl007/a2h --workflow deploy.yml --limit 3
gh run watch --repo xxl007/a2h
```

3. Run the two checks above: `a2h/dev/signing` has a new `AWSCURRENT` version and the worker's `SIGNING_*` entries end in its id (mcp has none: it verifies with public keys from `signing_keys`).

Answers signed before the rotation stay valid: verification picks the public key by the answer's `key_id` in the `signing_keys` table, and the old key stays there with status `rotated` (spec `protocol/answer-attestation`, "Old key still verifies"). The worker records the new key as `active` and moves the previous one to `rotated` when it starts with a new key (tasks 5.3 and 5.5). The old private key is not kept anywhere; it is no longer needed.

If the key leaked, rotating stops new signatures with it but does not make old ones invalid. Marking the old `key_id` `revoked` in `signing_keys` makes every answer signed with it fail verification ("Revoked key"); that is a database change made after rotating, and its exact command is added here when the `signing_keys` table lands (task 3.1). Tell the PM which answers, if any, must stay valid.

### Rotating the approval key (`a2h/<stage>/approval`)

Same steps with `STAGE_KEY_GENERATIONS.dev.approval` (or `STAGE_KEY_GENERATIONS.prod.approval`). The key protects only approvals in flight: a pending approval is valid for 15 minutes, nothing about it is stored, and no answer or request depends on the key afterwards. So a rotation can only interrupt a request whose elicitation was shown in the last 15 minutes and not yet accepted, or one whose retry lands on a task still running the old key while the deploy rolls (a minute or two). That principal's client gets an "invalid request state" refusal and simply asks again. To avoid even that, rotate when no one is using the stage.
