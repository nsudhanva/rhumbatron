# Decisions

Each Architecture Decision Record (ADR) states one decision, its reason, and its consequences.
The [architecture pages](../architecture/README.md) describe how the system works.

| ADR | Decision |
|---|---|
| [0001](./0001-repository-tooling.md) | Repository tooling |
| [0002](./0002-clerk-authentication.md) | Clerk for user authentication |
| [0003](./0003-vectorize-terraform-adapter.md) | Vectorize index through a Terraform adapter |
| [0004](./0004-resource-organization-and-bootstrap-credentials.md) | Resource organization and bootstrap credentials |
| [0005](./0005-durable-object-worker-deploys.md) | Deploy Durable Object Workers with cloudflare_workers_script |
| [0006](./0006-k2-terraform-adapter.md) | Terraform adapter for K2 streams |
| [0008](./0008-change-workflow-and-causal-routing.md) | ChangeWorkflow, Work Graph persistence, and causal routing |
| [0009](./0009-agentdo-pi-harness.md) | AgentDO on the Agents SDK with the Pi Durable harness |
| [0010](./0010-artifacts-project-source.md) | Artifacts as Project source |
| [0011](./0011-sandbox-workspaces.md) | Sandbox workspaces with a prebuilt image |
| [0012](./0012-sandbox-worker.md) | Sandbox class in its own Worker, deployed in one upload |
| [0013](./0013-promotion-preconditions.md) | Promotion preconditions split between the integration Worker and ProjectRootDO |
| [0015](./0015-advisory-claims.md) | Advisory Claims for agent runs |
| [0017](./0017-prod-environment.md) | Prod environment |
| [0019](./0019-runaway-billing-guards.md) | Runaway-billing guards |
| [0020](./0020-live-apps-dynamic-workers.md) | Live apps on Dynamic Workers |
| [0021](./0021-anthropic-model-provider.md) | Anthropic as the model provider |
| [0022](./0022-empty-repositories.md) | Every Project starts from an empty repository |
| [0023](./0023-shared-projects.md) | Shared Projects |
| [0024](./0024-single-prod-environment.md) | Prod is the only remote environment |
| [0025](./0025-system-decides-requests.md) | The system decides requests, and asks before it builds |
| [0026](./0026-candidate-selection-and-acceptance.md) | Candidate selection among siblings and the acceptance check |
| [0027](./0027-server-rendered-page-data.md) | Server-rendered page data and the phone text floor |
| [0028](./0028-roles-and-request-review.md) | Project roles and member request review |
| [0029](./0029-code-edit-sessions.md) | Code page edit sessions with a terminal |
| [0030](./0030-budget-scopes.md) | Budget scopes for requests, Projects, and users |
| [0031](./0031-ci-cd.md) | CI/CD: checks on pull requests, Terraform deploy on each push to main |
