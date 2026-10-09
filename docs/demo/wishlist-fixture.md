# Wishlist design-conflict fixture (P9-08)

The repeatable source of the demo conflict (AGENTS.md sections 4, 32.4, 54, 55). Two complete
implementations of shared wishlists on top of `fixtures/acme-shop`, published as real ChangeSets
without a model call. Executable Evidence, not the fixture, decides the winner.

## Designs

| | Design A | Design B |
|---|---|---|
| Data model | Normalized mutable tables. `wishlist_collaborators` rows are updated in place on remove and revoke. | Append-only membership event log. A materialized current-member set is updated by each event. |
| Read path | Access is derived from the collaborator table on every request: one scan per check, and one check per item for `addedByRole`. | Reads use the materialized set: one map lookup per check. |
| Task key | `wishlist-membership-table` | `wishlist-membership-log` |

The two designs share the HTTP contract, the page `public/wishlist.html`, the acceptance and
authorization tests, and the benchmark (`fixtures/wishlist/files/shared`). Only
`src/wishlist/model.ts` and one model test differ. Their Intents both name `wishlist:membership`
and declare incompatible storage models (`mutable_table` and `append_only`), so the deterministic
detector reports a confirmed conflict with `fork_candidates`.

## Why Design A fails

`bench/wishlist.bench.ts` loads the same seeded dataset for both designs: 30,001 wishlists,
2,000 products, about 360,000 memberships and 240,000 items. It then sends the requests a busy
shared list gets (80% reads, 20% item adds and removes, as a collaborator) to the newest list,
which has 42 members and 120 items. Design A does about 120 scans of the 360,000-row membership
table per read. That is the cost of recomputing access from the table, not a sleep. Design B
does 120 map lookups. `bun run bench` runs the cart and wishlist benchmarks and reports the
slowest endpoint's p95 as the API p95.

Measured on an Apple Silicon laptop (`bun run demo:wishlist --local`):

| Check | Design A | Design B |
|---|---|---|
| build (`bun run typecheck`) | pass | pass |
| unit (`bun test`) | 25 pass | 25 pass |
| contract | 8 added, all declared | 8 added, all declared |
| protected Cart invariant | 10 pass | 10 pass |
| security (`--test-name-pattern authorization`) | 6 pass | 6 pass |
| performance (p95 < 200 ms) | 414 to 509 ms: fail | 0.07 to 0.10 ms: pass |

The Project Sandbox (`basic`, 1/4 vCPU) is slower, which makes A slower still and leaves B far
below the budget. The wishlist benchmark stops after 15 s with at least 12 samples, so A stays
inside the 120 s check timeout.

With the page in `public/`, the Candidate plan also has the Browser Run check (risk `high`, UI
touched). The shop root has no `data-testid="wishlist"`, so the browser check runs its section
35 API scenario, which this contract satisfies.

## Pipeline

1. `POST /v1/changes/:changeId/fixture-changesets` `{"design": "a" | "b" | "both"}`. Dev only:
   the route answers 404 unless `ENVIRONMENT` is `dev` or `local`. Requires auth and Project
   membership, an active Project, and a Change in `created` (unplanned) or `verifying`. It queues
   `fixture.publish` on the integration Queue. `GET` on the same path shows what is published.
2. The integration Worker (`workers/integration/src/fixture-changesets.ts`), per design:
   records a Work Graph Task (`completed`, model policy `fixture`, `touchesAuthorization`), forks
   the canonical repo into `ws-<run>`, commits the design on the canonical commit with
   isomorphic-git (fixed commit date, so a retry is a no-op), and inserts a `task_runs` row (tier
   `fixture`, zero model calls) and a `proposed` ChangeSet. It sets the Change to `verifying` with
   risk `high`, the acceptance criteria, and the Cart invariant. It then declares both Intents on
   the Change's ResourceShardDO and records the conflict and its Challenge, using the agents'
   detector and conflict ID rule. Events use actor `system:fixture`.
3. `POST /v1/changes/:changeId/candidates` takes an optional `{"changeSetIds": [...]}` subset, so
   design A and design B become separate Candidates. Without a body it composes every proposed
   ChangeSet, as before.

Workspace forks are tracked by their `task_runs` rows, so Project cleanup and the fork sweep
delete them.

## Commands

```sh
bun run demo:wishlist --local          # both designs, local checks, no Cloudflare
bun run demo:wishlist --local a        # one design; add --keep to keep the temp checkout
bun run demo:wishlist                  # dev: new Change on acme-shop-demo, then A and B Candidates
bun run demo:wishlist --change chg_... # dev: resume or re-print an existing Change
```

The remote run expects `acme-shop-demo` (`bun run demo:project`) and the dev Workers deployed.
It ends with A `rejected` on `performance` and B `verified`, waiting for human approval.

## Limits

- The shop's store is in memory per isolate. On the deployed shop Worker, wishlist state and
  share links do not survive an isolate restart and are not shared across isolates.
- The fixture applies to the Acme Shop baseline. After a promotion changes `src/app.ts`,
  `src/store.ts`, `package.json`, `README.md`, or `public/index.html`, publishing refuses with an
  anchor error instead of committing a wrong patch.
