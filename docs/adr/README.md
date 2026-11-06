# Decisions

Each Architecture Decision Record (ADR) states one decision, its reason, and its consequences.
The [architecture pages](../architecture/README.md) describe how the system works.

| ADR | Decision |
|---|---|
| [0001](./0001-repository-tooling.md) | Repository tooling |
| [0002](./0002-clerk-authentication.md) | Clerk for user authentication |
| [0008](./0008-change-workflow-and-causal-routing.md) | ChangeWorkflow, Work Graph persistence, and causal routing |
| [0009](./0009-agentdo-pi-harness.md) | AgentDO on the Agents SDK with the Pi Durable harness |
| [0010](./0010-artifacts-project-source.md) | The git service as Project source |
| [0011](./0011-sandbox-workspaces.md) | Sandbox workspaces with a prebuilt image |
| [0013](./0013-promotion-preconditions.md) | Promotion preconditions split between the integration module and ProjectRootDO |
| [0015](./0015-advisory-claims.md) | Advisory Claims for agent runs |
| [0020](./0020-live-apps-dynamic-workers.md) | Live apps on workerd with the Worker Loader |
| [0021](./0021-anthropic-model-provider.md) | Anthropic as the model provider |
| [0022](./0022-empty-repositories.md) | Every Project starts from an empty repository |
| [0023](./0023-shared-projects.md) | Shared Projects |
| [0025](./0025-system-decides-requests.md) | The system decides requests, and asks before it builds |
| [0026](./0026-candidate-selection-and-acceptance.md) | Candidate selection among siblings and the acceptance check |
| [0027](./0027-server-rendered-page-data.md) | Server-rendered page data and the phone text floor |
| [0028](./0028-roles-and-request-review.md) | Project roles and member request review |
| [0029](./0029-code-edit-sessions.md) | Code page edit sessions with a terminal |
| [0030](./0030-budget-scopes.md) | Budget scopes for requests, Projects, and users |
| [0032](./0032-first-come-conflicts.md) | First-come conflicts between requests of different people |
| [0033](./0033-platform-admin-and-access.md) | Platform admin, sign-up approval, and user costs |
| [0034](./0034-docker-compose-stack.md) | One Docker Compose stack on open-source backends |
