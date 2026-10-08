# ADR 0006: Temporary Terraform adapter for K2 streams

- Status: Accepted
- Date: 2026-10-08
- Decider: Project owner

## Context

Phase 4 needs K2 streams and subscriptions (AGENTS.md section 19). Provider 5.27 has no K2 resource.
K2 is required for the current milestone, so section 11.4 steps 6 to 10 apply. K2 billing is not
enabled during the beta; Rhumbatron must still stay within free limits (rule 50).

## Decision

- `terraform_data.k2_streams` runs `scripts/k2-sync.ts`, keyed by a hash of the desired config.
  It lists streams first (read-before-write), creates missing streams and subscriptions, and
  fixes retention. It refuses to run outside `terraform apply`.
- `data.external.k2_streams` runs the read-only `scripts/k2-read.ts` to return stream IDs. Its
  `depends_on` defers the read to apply time, so a fresh environment works in one apply.
- Stream IDs feed `k2` bindings (`EVENTS_00`..`EVENTS_07`) on the coordinator Worker.
- Dev: 8 streams `rhumbatron_events_NN_dev`, 7-day retention, subscriptions `causal-router`,
  `project-view-projector`, `audit-archiver`, `analytics-projector`.
- K2 names allow only letters, digits, and underscores, so K2 is the one exception to the
  hyphenated naming pattern.

## Consumers

K2 has no push delivery to Workers; consumers pull over HTTP with leases and acknowledgements.

- `rhumbatron-event-router` consumes `project-view-projector` and `causal-router`.
- Fast path: after a successful publish, the coordinator calls the router's `nudge(streamIndex)`
  RPC through a service binding, so the UI sees events within seconds.
- Safety net: a 1-minute Cron Trigger sweeps one stream per tick (all 8 every 8 minutes).
- Delivery is at least once. Consumers dedupe on `(consumer, event_id)` in D1
  (`processed_events`).
- Free-tier budget: about 1,440 cron runs per day plus one nudge per publish; each invocation stays
  under the 50-subrequest limit.

## Deletion

The adapter never deletes streams. A config change replaces `terraform_data`, and a destroy-time
delete would then drop retained events. Removing a stream is a deliberate manual step recorded
here; it is not safe to automate.

## Limits and cost

- Account beta limits: 20 streams, 10 GB storage. Dev uses 8 streams; prod will need its own set
  (16 of 20 total). Other projects on the account share these limits.
- Billing is disabled in beta (at least 30 days' notice before it starts). Listed prices:
  $0.04/GB produced, $0.04/GB consumed, $0.02/GB-month retained.

## Replacement

Replace the adapter with the first-party resource when the provider adds one, then delete both
scripts and the `hashicorp/external` provider.
