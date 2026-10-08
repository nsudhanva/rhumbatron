# ADR 0004: Resource organization and bootstrap credentials

- Status: Accepted
- Date: 2026-10-08
- Decider: Project owner

## Context

1. Cloudflare resources must show which project, environment, and component they belong to.
   Cloudflare Resource Tagging supports key-value tags on D1, KV, R2, Queues, Workers, AI
   Gateway, Vectorize, and Durable Object namespaces. Provider 5.27 manages tags only on
   `cloudflare_worker`.
2. Terraform needs an API token before it can run, and the state backend needs an R2 key. The
   `cf` CLI OAuth session can create account tokens but cannot grant "Account API Tokens Write",
   so a CLI-created Terraform token cannot create the backend key inside Terraform.

## Decision

### Organization

- Name every resource `rhumbatron-<component>-<env>`, with `env` in `dev`, `prod`, `global`.
  The guardrail script enforces this for Terraform names.
- Tag Workers with `project:rhumbatron`, `env:<env>`, `component:<component>`,
  `managed-by:terraform`.
- Apply the same tags to other resource types when the provider adds a first-party tagging
  resource. Do not build a `terraform_data` adapter for tags.

### Bootstrap credentials

These two credentials are the only Cloudflare objects created outside Terraform. Both are created
with the `cf` CLI and stored in the macOS Keychain, never in Git or Terraform files.

| Token | Scope | Keychain service |
|---|---|---|
| `rhumbatron-terraform-global` | Account: R2, D1, KV, Queues, Vectorize, Workers Scripts, AI Gateway (write), Account Settings (read). Zone `rhumbatron.com`: Zone (read), Zone Settings, DNS, Workers Routes (write). | `rhumbatron-cloudflare-api-token` |
| `rhumbatron-terraform-state-backend-global` | R2 object read/write on `rhumbatron-terraform-state-global` only. | `rhumbatron-r2-state-access-key-id`, `rhumbatron-r2-state-secret-access-key` |

## Consequences

- Rotating either credential is a manual `cf` CLI step. Record each rotation in this ADR.
- Non-Worker resources are grouped by name only until provider support exists.
