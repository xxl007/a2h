# Runbook: AWS bootstrap (one time, performed by the product owner)

This runbook lists every manual step that must happen once before CI can deploy A2H to AWS. Agents never deploy (CLAUDE.md); after this runbook, every deployment is a GitHub Actions run that assumes an IAM role through OIDC. Nothing here is executed by an agent.

Read with: `docs/decisions/0001-stack-and-hosting.md` (what gets deployed), `infra/README.md` (stage model, shared resources, SSM contract), `.github/workflows/*.yml` (what CI does with the role), `openspec/changes/m0-foundation/tasks.md` §Step 4 (the contract between infra and CI).

## 0. What was observed on 2026-10-21 (read-only, from the local `a2h` profile)

| Item | State |
|---|---|
| AWS account | `725960317785`, home region `eu-west-3` |
| Local IAM user | `galem`, policy `AdministratorAccess`, one active access key created 2026-10-21 10:06 UTC (the key pasted in chat; rotate it, §2) |
| GitHub OIDC provider | **Already exists**: `arn:aws:iam::725960317785:oidc-provider/token.actions.githubusercontent.com` (created 2026-06-30 for another project). Do not create a second one. |
| IAM roles for A2H CI | Do not exist yet (§3) |
| SES (eu-west-3) | Sandbox, sending enabled, 200 messages / 24 h, no verified identity |
| Route 53 | One hosted zone `aiplayboox.com.` belonging to another project; A2H has no domain yet (§8) |
| SST state / bootstrap buckets | None yet (`sst-state-*`, `sst-asset-*` appear on the first deploy) |
| RDS | No cluster yet |
| Budgets | None |

Decisions you need to make before §7: see "Decide first" in the step-4 PR description.

## 1. Account hygiene (10 minutes)

1. Root user has MFA. Check in IAM → Dashboard → Security recommendations.
2. Create a monthly cost budget with an email alert. Replace the amount if you prefer another ceiling:

```sh
aws budgets create-budget --profile a2h --account-id 725960317785 \
  --budget '{"BudgetName":"a2h-monthly","BudgetLimit":{"Amount":"80","Unit":"EUR"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"<your email>"}]}]'
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
| `gha-a2h-dev` | Workflows running on `main` only (subject `repo:xxl007/a2h:ref:refs/heads/main`) | `deploy.yml` (push to `main`, and the manual first deploy) |
| `gha-a2h-preview` | Workflows triggered by a pull request of this repository (subject `repo:xxl007/a2h:pull_request`) | `preview.yml`, `teardown.yml` |

```sh
# 1. The ceiling every role SST creates must carry: no IAM, no role assumption.
aws iam create-policy --profile a2h --policy-name a2h-workload-boundary \
  --policy-document file://infra/bootstrap/a2h-workload-boundary.json \
  --description "Permissions boundary for every a2h-* workload role created by SST"

# 2. The two deploy roles. Their names start with gha-, so they can never touch themselves.
for r in dev preview; do
  aws iam create-role --profile a2h --role-name gha-a2h-$r \
    --assume-role-policy-document file://infra/bootstrap/gha-a2h-$r-trust.json \
    --max-session-duration 7200
  aws iam attach-role-policy --profile a2h --role-name gha-a2h-$r \
    --policy-arn arn:aws:iam::aws:policy/PowerUserAccess
  aws iam put-role-policy --profile a2h --role-name gha-a2h-$r \
    --policy-name a2h-sst-iam --policy-document file://infra/bootstrap/gha-a2h-deploy-iam.json
done

aws iam get-role --profile a2h --role-name gha-a2h-dev     --query Role.Arn --output text
aws iam get-role --profile a2h --role-name gha-a2h-preview --query Role.Arn --output text
```

Why this shape:

- `PowerUserAccess` covers everything SST creates (S3, ECR, ECS, ELB, RDS, SES, SSM, Secrets Manager, CloudFront, Lambda, DynamoDB, SQS, CloudWatch, Route 53, ACM) but no IAM.
- The inline policy adds IAM only for roles named `a2h-*`, which is how SST names roles (`a2h-<stage>-<component>-<hash>`, checked in SST 4.17.2). It may create or change those roles **only if they carry the boundary** `a2h-workload-boundary`. `sst.config.ts` puts the boundary on every role it creates. It can pass them only to ECS tasks and Lambda. It can never remove a boundary, edit the boundary policy, or touch the `gha-*` roles.
- So a workflow cannot turn its own role into an administrator. A workload role cannot change identities either.

Residual risks you accept by approving this for M0:

- **The preview role is as powerful as the dev role outside IAM.** A same-repository pull request that edits its own workflow could deploy over the `dev` stage, or change other resources in the account, including those of your other project. Only you and the A2H agents push to this repository, and forks get no OIDC token. The clean fix is a separate AWS account for A2H, or for previews, under AWS Organizations; it is worth doing before M3, when real participant data exists.
- **The preview trust cannot be pinned to a branch.** GitHub's pull-request token has no branch in its subject. Access Analyzer warns about exactly this, and it is the reason for the first point.
- **The `dev` stage still connects to Postgres as the master user** (previews do not, see `infra/README.md`). A dedicated application role is a task for the first database change in M1.
- **Choosing an EC2 NAT instance or a bastion later** (`infra/vpc.ts`) would need `iam:CreateInstanceProfile` added to the inline policy.

Session length: `sst deploy` of a fresh stage with two arm64 container builds under emulation takes 10 to 30 minutes. The 2-hour maximum session is headroom.

## 4. GitHub repository variables (5 minutes)

These are variables, not secrets. No AWS key exists anywhere in GitHub, which is what the `preview-environments` spec scenario "Secrets inventory" checks.

```sh
gh variable set AWS_DEV_ROLE_ARN     --repo xxl007/a2h --body "arn:aws:iam::725960317785:role/gha-a2h-dev"
gh variable set AWS_PREVIEW_ROLE_ARN --repo xxl007/a2h --body "arn:aws:iam::725960317785:role/gha-a2h-preview"
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
aws ssm get-parameters-by-path --profile a2h --path /a2h/shared/ --query 'Parameters[].[Name,Value]' --output table
aws ecs list-services --profile a2h --cluster "$(aws ssm get-parameter --profile a2h --name /a2h/shared/cluster-id --query Parameter.Value --output text)" --output table
ALB_ARN=$(aws ssm get-parameter --profile a2h --name /a2h/shared/alb-arn --query Parameter.Value --output text)
ALB_DNS=$(aws elbv2 describe-load-balancers --profile a2h --load-balancer-arns "$ALB_ARN" --query 'LoadBalancers[0].DNSName' --output text)
curl -si "http://$ALB_DNS/healthz" | head -1                                           # expect HTTP/1.1 200
aws elbv2 describe-load-balancer-attributes --profile a2h --load-balancer-arn "$ALB_ARN" \
  --query "Attributes[?Key=='idle_timeout.timeout_seconds'].Value" --output text      # expect 3600
aws iam list-roles --profile a2h --query "Roles[?starts_with(RoleName, 'a2h-')].[RoleName, PermissionsBoundary.PermissionsBoundaryArn]" --output table   # every row must show a2h-workload-boundary
```

If the deploy fails with `AccessDenied` on `iam:CreateRole`, a role was created without the boundary: send the PM the run URL; do not widen the policy by hand.

The eight `/a2h/shared/*` parameters are what every `pr-<n>` stage reads; if they are missing, previews cannot deploy. From now on every pull request from this repository gets a preview and a comment with its URLs; closing it tears the stage down, then drops its schema, its database login and its secret.

Also make the Postgres read-only role for the `postgres-readonly` MCP server (see `docs/runbooks/mcp-setup.md`) once you want agents to inspect data. It is not needed for M0.

## 8. Domain and TLS (decide; 20 minutes once decided)

Without a domain, the web stage URLs are CloudFront hostnames (HTTPS) and the MCP endpoint is the ALB hostname over **HTTP**. MCP Inspector and curl accept that; hosted MCP clients such as Claude.ai require HTTPS, so a domain is needed before any external agent connects (M1 Gate 2 at the latest).

1. Choose a domain for A2H (the existing `aiplayboox.com` zone belongs to another project). Register it in Route 53 or delegate its NS records to a new Route 53 hosted zone:
   `aws route53 create-hosted-zone --profile a2h --name <domain> --caller-reference a2h-$(date +%s)`
2. Set `domain` in `infra/config.ts` (see `infra/README.md` for how stage hostnames are derived) and merge. SST then issues the ACM certificates (us-east-1 for CloudFront, eu-west-3 for the ALB, DNS-validated in the zone), creates the records, and adds the HTTPS listener with the HTTP→HTTPS redirect.
3. ACM in us-east-1 is the single exception to the one-region rule (ADR 0001); it holds no data.

## 9. Email: SES identity and production access

Sandbox is enough for M0–M2: you can send to verified addresses only (your own), 200 per day.

1. Set `emailSender` in `infra/config.ts`: the domain from §8 (preferred, SST adds DKIM/SPF/DMARC records in Route 53) or a single address for now (SES mails that address a verification link; click it).
2. Before M3 (request delivery to real participants), request production access. Explain the use case as transactional email to participants who opted in on A2H, with one-tap decline links and bounce/complaint handling through the SES configuration set events:

```sh
aws sesv2 put-account-details --profile a2h --region eu-west-3 \
  --production-access-enabled \
  --mail-type TRANSACTIONAL \
  --website-url https://<domain> \
  --use-case-description "A2H sends transactional notifications (request summaries, decline links, answer notifications, payout notices) to participants who created an account and opted in. Bounces and complaints are processed through SES event notifications and suppress the address." \
  --additional-contact-email-addresses <your email> \
  --contact-language EN
```

AWS answers within 96 hours. Having a verified **domain** identity before asking speeds approval.

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
