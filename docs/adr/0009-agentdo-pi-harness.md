# ADR 0009: AgentDO on the Agents SDK with the Pi Durable harness

## Context

A durable agent needs a model and tool loop. The Agents SDK (`agents` 0.27.0) gives `PiHarness`
with `@earendil-works/pi-durable` 1.1.0 (beta). With it, Pi runs inside an actor, keeps
transcripts in the actor's SQLite file, and resumes after a restart. The actor host in
`packages/platform` gives the actor model that the SDK expects.

## Decision

- `AgentDO` (`workers/agents`) extends the Agents SDK `Agent` and runs `PiHarness`. It implements
  `AgentRuntime`. No Pi type crosses that boundary. One instance exists per logical agent ID.
- Models: one pi-ai provider, `rhumbatron`, with the models `tier-haiku`, `tier-sonnet`, and
  `tier-opus`. Requests go to the Anthropic API (ADR 0021). The opus tier runs on
  Sonnet while `ALLOW_OPUS` is not `"true"`.
- Tools (`workers/agents/src/task-tools.ts`): every run gets `list_files`, `read_file`,
  `write_file`, `edit_file`, `delete_file`, `run_command`, `complete_task`, and `fail_task`.
  - `complete_task` (with a typed Intent) and `fail_task` end a run. Both are idempotent.
  - Only `implement`, `migrate`, and `test` Tasks open a workspace (ADR 0011). For other Tasks,
    `list_files` and `read_file` read the canonical commit, and the write and command tools answer
    "This Task has no workspace".
- Routing: deterministic rules first, then Clef-flash only for the generic case. The rule floors
  apply to the Clef-flash answer too. Each attempt has a Decision Receipt in the product database
  and the Event `model.route.decided`.
- Escalation: two intelligence failures at one tier escalate one tier. Two failures at the top
  tier (Sonnet while Opus is off) send the Task to re-planning. A transport failure retries once at
  the same tier. Each attempt starts a fresh Pi session.
- Budgets: a gate before each model request caps calls per run (`MAX_CALLS_PER_RUN`: 16 haiku,
  32 sonnet, 32 opus) and agent calls per UTC day (`AGENT_DAILY_CALL_CAP`: 1,000). The monthly
  Anthropic budget also applies (ADR 0021). A budget stop blocks the Task and its dependents, and
  marks the Change `budget_blocked`.
- Claims: a run takes advisory Claims (ADR 0015).
- Liveness: while a run is active, AgentDO checks it every 60 s (`scheduleEvery(60)`). It sets no
  timers when idle. Each check counts against the daily cap on self-scheduled callbacks
  (`DAILY_ALARM_CAP`, 2,000 per actor per UTC day). A run that ends without a terminal tool counts
  as `no_outcome`. After 15 checks, AgentDO stops the run (`timeout`).
- The core service registers `AgentDO` on the actor host as the `AGENT` namespace. Each
  instance has its own SQLite file.

## Risks

`PiHarness` and Pi Durable are beta APIs and can change. Only `agent-do.ts`, `models.ts`, and
`task-tools.ts` import them.

## Diagram

One run, as `AgentDO.start` and its callbacks implement it.

```mermaid
flowchart TD
  wake["AgentDO.start (wake consumer or retryTask)"] --> step["nextStep: retry, escalate, replan, or stop"]
  step --> route["Route the tier: rules, then Clef-flash"]
  route --> ctx["Context packet, snapshot to the object store"]
  ctx --> rcpt["Decision Receipt (database) and model.route.decided"]
  rcpt --> claims["Acquire advisory Claims (ADR 0015)"]
  claims --> pi["PiHarness session: tier-T"]
  pi --> gate["beforeModelCall: budget and daily caps"]
  gate --> mcall["Model call to the Anthropic API"]
  mcall --> tools["Tool calls"]
  tools --> pi
  tools -- "complete_task or fail_task" --> finish["finishRun: release Claims, record outcome"]
  check["checkRun every 60 s<br/>15 checks: timeout"] --> finish
  finish -- "retry or escalate: retryTask in 5 s" --> wake
```
