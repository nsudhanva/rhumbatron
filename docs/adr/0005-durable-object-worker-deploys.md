# ADR 0005: Deploy Durable Object Workers with cloudflare_workers_script

- Status: Accepted
- Date: 2026-10-08
- Decider: Project owner

## Context

AGENTS.md section 11.5 prefers `cloudflare_worker` + `cloudflare_worker_version` +
`cloudflare_workers_deployment`. Cloudflare rejects Durable Object class migrations
(`new_sqlite_classes`, renames, deletes) in version uploads; they need a full script deploy.

## Decision

- Workers that host Durable Object classes use `modules/durable-worker`, built on
  `cloudflare_workers_script` (full deploy, supports `migrations`). Today: `rhumbatron-coordinator`.
  Later: `rhumbatron-agents`.
- All other Workers keep `modules/worker` (version + deployment), which canary rollout needs later.
- Migrations are expressed as a transition from the live tag to the target tag. `old_tag` must
  equal the live tag, or Cloudflare rejects the upload (412, code 10079). Steady state is
  `old_tag = new_tag = <live tag>` with no class changes. Never edit an applied tag.

## Consequences

- `cloudflare_workers_script` has no tags attribute, so Durable Object Workers are grouped by name only.
- Gradual rollout does not apply to Durable Object Workers. Each release is a full deploy.
- The module declares observability and compatibility flags in full to keep the post-apply plan clean.
