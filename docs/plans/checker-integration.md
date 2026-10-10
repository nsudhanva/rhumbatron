# AppChecker integration

Add an integration Worker service binding `APPS_CHECKER`, targeting the apps Worker entrypoint
`AppChecker`, through Terraform. Add the matching local binding and generated types. Keep `APPS`
on `AppBuilder`. This change exports the checker; it does not deploy or wire the workflow.

After composition, call `storeTreeCode(env, candidateRepo, { projectId, commit, treeSha })` for the
exact composed tree. Store the base tree separately for contract checks. The checker reads the
existing EVIDENCE R2 `codeManifestKey(projectId, treeSha)` and `codeBlobKey(projectId, blob)`;
it cannot backfill from Artifacts. Missing, partial, or mismatched source is a gap.

Inside each relevant Workflow step:

```ts
const result = await env.APPS_CHECKER.check({
  projectId,
  treeSha: composition.tree,
  kind: "unit", // or "build" / "contract"
  timeoutMs: Math.min(check.timeoutMs, 30_000),
});
```

Persist the reply's status, coverage, summary, timestamps, output, and unit counts/failures as
Evidence. `supported: false` permits the existing Sandbox check, subject to its budget. Preserve
both attempts and the fallback reason. This includes missing runners, unsupported APIs, empty
test files, native/binary source, filesystem access, bundling/load errors, timeouts, and limits.
If fallback cannot run, retain `not_checked`. `supported: true` plus `status: fail` is a completed
assertion failure: retain it, without retrying it into a pass. Checker failures also carry
`not_checked`. Only `pass` plus `checked_supported` satisfies the gate. Do not reclassify unit
results through `classifyCheck` using only an exit code.

For contract, check both base and Candidate trees. Adapt each successful reply to
`{ exitCode: result.exitCode, output: result.output, timedOut: result.timedOut }` and call existing
`classifyContract(baseRun, candidateRun, declared)`. Output is one `{"routes":[...]}` line;
`parseRouteTable` and `diffContract` need no change. Base `null` is allowed only after proving it
has no package.json, as today. Failed extraction is never an empty contract. On unsupported
extraction, use `runContractCheck` for both revisions, or retain a gap.

Build calls the existing AppBuilder on the preview channel, then loads its entry module without
calling app fetch. It may store/reuse a preview bundle but moves no app pointer. It does not run
the plan's `bun run typecheck`: change that check's explicit procedure to bundle/load, or retain
the Sandbox semantic typecheck. Never claim the current command ran.

Unit bundles every `*.test.ts` separately, with a virtual `bun:test` alias. Supported APIs:
describe, it/test, beforeEach/afterEach; toBe, toEqual, toBeTruthy, toBeFalsy, toContain, toThrow,
toHaveLength, toBeNull, toBeDefined, and `.not`. Tests/hooks can be async; describe/toThrow cannot.
Equality covers plain objects, arrays, dates, regexes, and cycles. Other APIs, skips, focused
or parameterized tests, callback/options runners, and other extensions require fallback.
The Acme catalog's toBeGreaterThanOrEqual currently requires fallback.

Contract runs scripts/contract.ts when present and captures stdout/console JSON. Fixture literal
`${root}/...` imports resolve to this supplied tree without filesystem access. Otherwise it reads
Hono default/app exports or src/app.ts createApp, with src/store.ts createStore when present;
ALL middleware is excluded and routes are deduplicated/sorted. Other factories or dynamic
filesystem imports may need fallback.

Limits: fresh LOADER.load per execution, empty env, globalOutbound null, 50 ms CPU, one subrequest;
1–16 test files, 1,000 tests/file, 400 source files, 8 MB source, 1 MB/blob, 10 MB modules,
2 MB/child report, 30 s deadline. A timeout discards late results and stops later executions;
it cannot cancel an already-running bundler or child I/O. No Sandbox starts inside AppChecker.
Before enabling, reserve/meter creation allowance shared with live apps and the existing build
budget. Unit creates one child/file; build/contract creates one. Keep shared Workers and R2 usage
within the approved included budget. Do not enable without that budget gate.

Pure critical tests cover assertions, hooks, source bounds, orchestration, and coverage mapping.
Local workerd smoke checks passed for generated unit programs (including blocked network and
fresh state), build module loading, and both contract paths. The complete R2/AppBuilder RPC path
still needs a local or live integration check.

References: [Loader API](https://developers.cloudflare.com/dynamic-workers/api-reference/),
[limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/),
[bindings](https://developers.cloudflare.com/dynamic-workers/usage/bindings/).
