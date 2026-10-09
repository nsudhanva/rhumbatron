# ADR 0011: Sandbox workspaces with a prebuilt image and a Terraform-run adapter

- Status: Accepted; the container attach mechanism is superseded by ADR 0012
- Date: 2026-10-08
- Decider: Project owner (HOM-192 cap; option A of the Sandbox deploy question)

## Context

Implementation Tasks must change and test real code (AGENTS.md sections 29.2, 30). Cloudflare
Sandboxes run on Containers. Deploying a container normally needs `wrangler deploy` or
`wrangler containers push`, which rule 5 forbids, and Docker, which this machine does not have.
Provider 5.27 has no container application resource.

## Decision

- Image: the prebuilt public `docker.io/cloudflare/sandbox:0.12.6` (Bun, git), matched to
  `@cloudflare/sandbox@0.12.6`. Containers pull public Docker Hub images under the `default`
  scheduling policy, so no local build and no `wrangler containers push` is needed. The owner
  approved a `wrangler containers push` exception if a custom image is ever required; it is not
  used.
- The agents Worker exports the SDK's `Sandbox` class (Durable Object migration v2, applied). A
  temporary adapter (`scripts/containers-sync.ts`, `terraform_data.sandbox_container`) runs after
  the agents Worker upload, read-before-write, never deleting. The Terraform token has Workers
  Containers Write.
- Container wiring (verified against Wrangler 4.149.0 `wrangler-dist/cli.js` and live reads): a
  Durable Object class runs a container only when the deployed Worker version carries upload
  metadata `containers: [{ name, class_name }]` (cli.js ~169029, `getContainerMetadata` ~168173).
  Without it, creating the application fails with `DURABLE_OBJECT_NOT_CONTAINER_ENABLED`. Wrangler
  sends it in the script `PUT ?bindings_inherit=strict` (~180918), then resolves the namespace ID
  (~146070) and creates the application with `durable_objects: { namespace_id }` (~146321). The list
  is per version (`resources.script_runtime.containers`) and is not inherited (~168204).
  `cloudflare_workers_script` (provider 5.27) has no `containers` attribute; `cloudflare_worker_version`
  has one, but ADR 0005 keeps Durable Object Workers on the script resource.
- The adapter therefore (1) always re-uploads (a pre-upload read of the deployments list can lag
  and report the previous, attached version) the same bundle with the live settings, every binding as `{ type = "inherit" }` (secrets are never
  read), the `containers` entry, and no migrations; (2) creates or patches the application
  `rhumbatron-sandbox-<env>` (`basic`, `max_instances = 1`) bound by namespace ID. The API
  returns sizes, not `instance_type`, so drift is compared by Wrangler's size table; a real change
  patches and starts a rollout. Wrangler's first deploy does the same (upload, then create, no
  rollout), and Cloudflare says containers can error for several minutes after it.
- Drift: Terraform cannot see `containers`, so plans stay clean, but every Terraform upload of the
  agents script drops it. The triggers hash every input that makes Terraform re-upload (bundle
  hash, compatibility, secret, gateway, D1 and R2 bindings), so the adapter re-attaches in the same
  apply. A new agents binding input must be added to that hash, or run
  `terraform apply -replace=terraform_data.sandbox_container`. Between the Terraform upload and the
  adapter upload (about 15 s) the class has no container, and provisioning can take minutes after
  re-attachment. Moving the agents Worker to `cloudflare_worker_version` (`containers` attribute)
  would remove this window.
- Workspace: one Sandbox per Project, a directory per Task run. Each run forks the canonical
  Artifacts repo, clones it with a short-lived token passed as an environment variable (never in
  git config), and on `complete_task` commits and pushes to its fork. The result is a ChangeSet
  row (`changesets`) and a `changeset.proposed` event. Design, review, and document Tasks never
  open a workspace.
- Tools: `write_file`, `run_command` (allow-list: `bun install`, `bun test`, `bun run
  typecheck|test|bench`, `bunx tsc --noEmit`, `git status|diff|log`, `ls`; no shell
  metacharacters), and workspace `read_file`.

## Cost controls (HOM-192)

- `sleepAfter: "2m"` and the directory is removed when the run ends.
- Monthly meter in D1 `usage_counters` (`sandbox-seconds`, keyed by month): a session reserves
  300 s before opening and settles its wall time plus a 120 s idle tail when it closes. Opening
  stops at 36,000 s (10 hours); agents then declare Intents without code changes.
- `basic` (1/4 vCPU, 1 GiB): 10 hours is about 10 GiB-hours of the 25 included, and the account
  had no other container applications when this was created.

## Replacement

Use the first-party resources when the provider adds a container application resource and a
`containers` attribute on `cloudflare_workers_script` (or the agents Worker moves to
`cloudflare_worker_version`, which has one). Then delete the adapter.
