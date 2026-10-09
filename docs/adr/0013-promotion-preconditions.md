# ADR 0013: Split promotion preconditions between the integration Worker and ProjectRootDO

- Status: Accepted
- Date: 2026-10-09
- Decider: Project owner

## Context

AGENTS.md section 36 lists eight preconditions before one atomic `S<n> -> S<n+1>` transition.
Most of them read data that ProjectRootDO does not own: Candidate status, the Verification Plan,
and Evidence live in D1; approvals are D1 rows; the Candidate commit lives in an Artifacts fork.
ProjectRootDO owns only canonical generation, tree, ref, and the active policy version. A Durable
Object that reads D1 inside its transaction cannot make those reads atomic with its own state
anyway, and D1 reads would make the hottest correctness boundary depend on a second database.

## Decision

Two steps, in this order, for `POST /v1/candidates/:candidateId/promote`:

1. **Integration Worker (`promoteCandidate` RPC).** The API authenticates the user, checks project
   membership, and calls the integration Worker over the `INTEGRATION` service binding. The
   integration Worker has no public route. It reads authoritative rows and checks, with the pure
   function `checkPromotion` (`packages/evidence/src/promotion.ts`):
   - rule 1: Candidate status is `verified`;
   - rules 2 and 3: the required checks are gated again from `evidence_index` rows with
     `gateRequiredChecks`. The cached `score_json` gate is never trusted. Only `checked_supported`
     plus `pass` satisfies a check (section 34.4.1);
   - rule 4: when the plan or the policy risk tiers require it, a `granted` approval exists for the
     exact composed tree; a `rejected` approval always blocks;
   - rule 5 (early): the plan's policy version equals the active version;
   - rule 8: the composed commit still exists in the Candidate fork with the recorded tree.
   It then builds and Zod-validates a section 36 `PromotionRequest` and emits
   `canonical.promotion.requested`.
2. **ProjectRootDO (`promote`).** Decides on its own state, in one SQLite transaction:
   rule 5 (authoritative policy version), rule 6 (expected generation = current), rule 7 (expected
   tree = current, when the Candidate recorded its `base_tree`). It writes the new generation and
   the `canonical.advanced` outbox row together. The event records `requiredEvidenceIds` and
   `approvalId` for audit.

The expected generation is always the Candidate's `base_generation`; the browser cannot choose
it. The idempotency key is Candidate ID plus expected generation (section 60): a retry returns
`alreadyPromoted`. A generation or tree mismatch marks the Candidate `stale` and emits
`candidate.stale`; there is no blind retry (section 42.9).

### Approvals

`POST /v1/changes/:changeId/approve` records one decision per Candidate in `approvals`
(migration 0008). The approver is the authenticated member from the session, never from the
request body. Only a verified, gated Candidate can be decided; the first decision is final, and an
identical repeat returns the stored row. A rejection also sets the Candidate to `rejected`. The
policy is deterministic (`approvalRequired`, `checkApprovalDecision`); no model takes part.
`approval.requested` is emitted when a gated Candidate is verified; `approval.granted` or
`approval.rejected` when a decision is recorded.

### Canonical source after promotion

ProjectRootDO is the authority, so the canonical Artifacts repo moves after the compare-and-swap,
not before. The integration Worker fetches the Candidate fork with isomorphic-git into memory and
pushes the composed commit to the canonical repo's `main` as a fast-forward only (no force push;
receive-pack also checks the old value). It then writes `source/<project>/<tree>/index.json`.
That index is how agents and the verification workflow resolve the canonical commit, so it is
written only after `main` has moved. The new canonical ref is `artifacts://<project>@<commit>`.

If the sync fails, the generation has still advanced. The response says `sourceSynced: false`;
promoting again repairs it, because the retry is `alreadyPromoted` and re-runs the sync. Until
then, a new Candidate's verification waits on its first step (bounded retries) instead of
composing on a commit that `main` does not hold yet. No Sandbox time is used for the sync.

### Re-wake after promotion (P11-06)

On `canonical.advanced`, the Causal Router marks every other in-flight Candidate of the Project
with an older base as `stale` (one D1 batch, deterministic), and marks the promoted Candidate
`promoted`, which repairs the D1 mirror if the integration Worker stopped between the
compare-and-swap and its own write. It already wakes the agents of active Tasks on that event.

## Consequences

- The DO trusts its caller for rules 1 to 4 and 8. Only Workers with a `PROJECT_ROOT` binding can
  call it, and only the integration Worker calls `promote`.
- A precondition can change between the check and the compare-and-swap (for example a new
  Evidence row). Evidence IDs are stable per check, and a Candidate's Evidence is written only by
  its own verification workflow, which has finished once the Candidate is `verified`.
- New binding: `INTEGRATION` service binding on the API Worker (Terraform `api_worker`).
- Not done: separation of duties (an approver may also be the Change author; one-person
  organizations need this for now), `autoPromoteRiskTiers`, and release after promotion (P11-08).
