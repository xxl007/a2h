# ADR 0007: Licence, paid-code separation and marketplace packaging

- Status: item 1 (Apache-2.0 for the free part) accepted by the owner on 2026-11-11; items 2–5 proposed (PM recommendation)
- Date: 2026-11-11
- Deciders: product owner (Galem L.), PM agent
- Scope: the licence of the free edition, where paid code lives and how it is switched on, and the form in which A2H is listed on cloud marketplaces. Governs the repository's licence files, the package built in M2 and the listing in M4 (PRD v0.3 §11, §13).
- Related: ADR 0006 (A2H for organisations); ADR 0001 (provider-neutral business logic).

## Context

ADR 0006 makes A2H an open-source product with a paid edition, sold through cloud marketplaces, AWS first. The repository is public and has no licence file, so today nobody may legally use the code. A licence is hard to change once others depend on it: the instructive cases are HashiCorp's move to the Business Source License in 2023 ([announcement](https://www.hashicorp.com/en/blog/hashicorp-adopts-business-source-license)), which led to a fork, and Redis and Elastic each changing licence and later adding AGPL back ([Redis](https://redis.io/blog/agplv3/), [Elastic](https://www.elastic.co/blog/elasticsearch-is-open-source-again)). Choose once.

Facts below come from web research on 2026-11-11, from the linked primary pages unless listed under "Not verified".

## Recommendation

### 1. Licence of the free edition: Apache-2.0 (accepted)

| Licence | Open source (OSI) | Others may sell it as a service | Acceptance by company legal teams |
|---|---|---|---|
| Apache-2.0 / MIT | yes | yes | accepted; Apache adds a patent grant |
| AGPL-3.0 | yes | yes, if they publish their changes | often banned ([Google's policy](https://opensource.google/docs/using/agpl-policy/)) |
| [Elastic License 2.0](https://www.elastic.co/licensing/elastic-license) | no | no hosted service | usually fine for internal use |
| Business Source / [Functional Source](https://fsl.software/) | no | not in competition | case by case |

Apache-2.0 because the buyer is a company installing software internally: a licence its legal team already accepts removes a step from every adoption, and "open source" stays true without qualification. The cost: anyone may host or resell the free edition (not the paid code). The paid features and the marketplace listing are the defence, not the licence.

Contributions: a Developer Certificate of Origin for the free part; a contributor agreement for paid code and for any contribution we may later need to relicense.

### 2. Paid code: an `ee/` directory in the same repository, under a commercial licence, switched on by entitlement

This is what GitLab ([licence](https://gitlab.com/gitlab-org/gitlab/-/raw/master/LICENSE)), PostHog ([licence](https://raw.githubusercontent.com/PostHog/posthog/master/LICENSE)) and Langfuse ([docs](https://langfuse.com/docs/open-source)) do. One build and one CI suit a small team. The cost: paid source is readable, so the protection is the commercial licence plus the entitlement check. A private repository would hide the source and double the release work.

### 3. AWS Marketplace: a container product for the paid edition, sold mainly by private offer

- **Form.** Container images with a CloudFormation template for ECS/Fargate, and a Helm chart for EKS; the buyer supplies Postgres by connection string ([container product policies](https://docs.aws.amazon.com/marketplace/latest/userguide/container-product-policies.html)).
- **Packaging rules that shape the first release.** Every image, dependencies included, is served from the marketplace's own registry; nothing is pulled from outside at run time; no hard-coded secrets; access to AWS only through the task's or pod's role; image references in the Helm chart only in `values.yaml`; images scanned at every version.
- **Price model.** A 12-month contract with a base tier and a per-person dimension, as [Grafana Enterprise](https://aws.amazon.com/marketplace/pp/B09LMK1HD8) lists. The free edition is the trial.
- **AWS's fee.** 20% on public purchases of container products, 3% on private offers under USD 1M, 1.5% on renewals ([listing fees](https://docs.aws.amazon.com/marketplace/latest/userguide/listing-fees.html)). Hence private offers as the main route.
- **Alternative seen.** n8n lists a free container product and sells its self-hosted licence through a separate SaaS-type listing ([listing](https://aws.amazon.com/marketplace/pp/prodview-phou4jva26nvm)), which carries the 3% public fee but needs a registration page and entitlement service that we host.
- **Later.** A second delivery option that runs the MCP server alone on Bedrock AgentCore would list A2H under "AI agents and tools" ([guide](https://docs.aws.amazon.com/marketplace/latest/userguide/listing-container-ai-agents.html)); the whole product does not fit that option.
- **Seller registration.** EU sellers are eligible; paid listings need tax forms, VAT details, a bank account that accepts USD and identity checks ([eligibility](https://docs.aws.amazon.com/marketplace/latest/userguide/seller-eligibility.html)). This is the owner's to do.

### 4. Entitlement: one interface, two implementations

- **AWS:** check the licence with AWS License Manager at start and on a schedule, using the task's or pod's role ([integration guide](https://docs.aws.amazon.com/marketplace/latest/userguide/container-license-manager-integration.html)).
- **Elsewhere:** a signed licence key, for direct sales and for other clouds.
- **When a licence lapses or cannot be checked,** the install falls back to the free edition; it never stops. This is AWS's own recommendation, and it follows from PRD principle 9: protection never depends on a licence.

### 5. One cloud-neutral package

Azure's fitting offer is a Kubernetes application ([technical assets](https://learn.microsoft.com/en-us/partner-center/marketplace-offers/azure-container-technical-assets-kubernetes)); Google Cloud's is a Kubernetes app ([package guide](https://docs.cloud.google.com/marketplace/docs/partners/kubernetes/create-app-package)). Both, like AWS, want: one Helm chart with every image reference a parameter, Linux AMD64 images, nothing downloaded at run time, an external Postgres connection string. Building to that shape in the first release serves all three.

## Consequences

- The first release (PRD §13, M2) adds: `LICENSE` (Apache-2.0), `ee/LICENSE`, contribution terms, the Helm chart and CloudFormation template, the entitlement interface, and an audit that nothing is fetched at run time.
- The web app, today deployed to Lambda and CloudFront through SST, needs a container form for the package. SST stays as our own development deployment.
- Paid features built before the entitlement exists live in `ee/` from the start.

## Not verified

- Whether AWS would accept a SaaS-type listing for a purely self-hosted product; n8n has one, the guideline wording is ambiguous.
- Review time for container products (AWS states 2–4 weeks overall) and how long identity checks take.
- Whether an EU bank account suffices; current AWS pages say an eligible account accepting USD, older posts said a US account.
- Google Cloud Marketplace's fee percentage.
- The open-source status of the source-available licences in the table, taken from the licences' own pages rather than the OSI list.
