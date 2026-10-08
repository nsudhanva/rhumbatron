# ADR 0003: Defer the Vectorize index until first-party Terraform support

- Status: Accepted
- Date: 2026-10-08
- Decider: Project owner

## Context

P1-10 asks for the `rhumbatron-memory-<env>` Vectorize index. Cloudflare Terraform provider 5.27
has no Vectorize resource. AGENTS.md section 11.4 forbids dashboard, Wrangler, or direct API
creation, and prefers waiting when the feature is not needed for the current milestone.

Nothing reads Vectorize before Phase 7 (P7-05).

## Decision

Do not create the index in Phase 1. Re-check provider coverage at the start of Phase 7.

If no first-party resource exists then, build the temporary `terraform_data` adapter that section
11.4 describes (idempotent, read-before-write, delete support, invoked only by `terraform apply`).

## Planned shape

- Name: `rhumbatron-memory-dev`, `rhumbatron-memory-prod`.
- Dimensions: 768, metric cosine (matches Workers AI `bge-base-en-v1.5`). Changing either later
  replaces the index.
- Binding name: `MEMORY`.

## Consequences

- Phase 1 completes without P1-10. `docs/BUILD_STATUS.md` lists it as deferred.
- Phase 7 owns the creation work.
