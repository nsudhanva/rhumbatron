# ADR 0029: Code page edit sessions with a terminal

## Context

The Code page lets the owner or an admin save one file of the live tree as a human Change
(`code-edit.ts`). A real fix often changes more than one file, adds or deletes a file, or needs a
command such as `bun test` before the person sends it. These rules apply:

- A person never advances canonical directly. Only verified Evidence advances the Canonical State.
- The Sandbox costs Container time. The Project has one Sandbox (`proj-<uuid>`, `max_instances = 1`)
  that agents and Candidate checks share (ADR 0011). The monthly meter `SANDBOX_MONTHLY_SECONDS`
  limits it to 72,000 s (20 hours) in prod.
- The Sandbox never gets a Terraform, Cloudflare API, or model credential.

## Decision

- Only the owner and the admins (`can(role, "code.edit")`) open a session. Each person has at most
  one open session per Project (unique index `code_sessions_one_open`). A second open returns the
  open session. A session belongs to the person who opened it. Another person, also an admin, gets
  404 for it. Everyone else uses the read-only Code page.
- The API Worker (`workers/api/src/code-sessions.ts`) checks the role and the owner of the session
  on each request. It calls the integration Worker through the `INTEGRATION` service binding (RPC).
  The integration Worker (`workers/integration/src/code-sessions.ts`) owns the session state, the
  fork, and the Sandbox. It checks the owner and the session state again from D1.
- Open: the session forks canonical into the Artifacts repository `edit-<hex>` for session
  `edit_<hex>`. Cleanup derives the name only from the D1 row ID. The open does not start the
  Sandbox.
- Edits: D1 `code_session_files` holds each changed file (its full text) or a deleted path. Reads
  come from the edits, then from the R2 code store of the base tree, then from Artifacts. A file
  path is under the repository root, has no `..` part, and has no `.git` part at any depth. A file
  is text (no NUL byte) and at most 256 KB. A binary file is refused with 415, a large file with
  413. A session holds at most 200 changed paths.
- Terminal: the first command starts the Project Sandbox. The session checkout is
  `/workspace/edit-<hex>`. Root clones the fork with a read token in its own environment and
  revokes the token. Each command then runs:
  - as an unprivileged user that is unique to the session (`setpriv`, no groups, no new
    privileges), with a clean environment (`PATH`, a session `HOME`). No token and no secret is in
    it. It cannot change agent or Candidate checkouts.
  - with the network policy of the Project Sandbox, the same as agent commands.
  - with a 120 s timeout. A timeout returns exit code 124.
  - with each output stream cut to its last 64 KB.
  After each command, a kill as the session user stops every process of the session. Every file
  that differs from the base becomes a session edit. A binary file, a file over 256 KB, or an
  invalid path stays out, and a note in `stderr` names it.
- Meter: each command reserves 480 s on `usage_counters` (`sandbox-seconds`) before the Sandbox
  starts. At the cap, the command is refused with 429 and reason `sandbox_cap`. After the command,
  the meter settles to the awake time that the command added (its time plus a 120 s idle tail).
  Commands within one tail pay the overlap once.
- Audit: `code_session_commands` records each command, its folder, exit code, duration, and time.
  It never records the output.
- Submit: all edits become one Change with one human ChangeSet through `recordHumanChange`, the
  path of the single-file save with several files. The commit is in the human workspace fork
  `ws-<k>`. The Change then composes, verifies, previews, and releases as an agent Change does.
  If canonical advanced and did not change an edited file, the submit moves to the new base. If
  canonical changed an edited file, the submit is refused with 409 `stale_base`. A repeat finds
  the same Change.
- End: discard, submit, 10 minutes without a request (`CODE_SESSION_IDLE_MS`), 2 hours after the
  open (`CODE_SESSION_MAX_MS`), or an archived Project. Each request checks the limits first, and
  the daily maintenance sweep (`forks.sweep`) ends overdue sessions. The end deletes the fork and
  the edits. Edits that are not submitted are discarded. The web warns 1 minute before the idle
  limit.
- Sandbox stop: while the Sandbox is awake, the end kills every process of the session and
  removes its directory. Then the Sandbox sleeps after 2 idle minutes (`sleepAfter`). A sleeping
  Sandbox has no disk, so the end does not wake it. The end does not destroy the Sandbox, because
  agents and Candidate checks of the Project can use it at the same time.
- Events: `code.session.opened`, `code.session.closed` (with `reason`: `discarded`, `idle`,
  `max_age`, or `archived`), and `code.session.submitted` (with `changeId`). They are
  informational for the causal router.
- Project cleanup deletes the `edit-*` forks, `code_session_files`, `code_session_commands`, and
  `code_sessions`.

## Alternatives considered

| Alternative | Why it lost |
|---|---|
| Keep the edits only in the Sandbox checkout | The Sandbox sleeps after 2 idle minutes and loses its disk. A session lives up to 10 idle minutes. |
| A separate Sandbox instance for each session | The container application has one instance (ADR 0011). A second instance doubles the Sandbox hours. |
| Destroy the Sandbox when a session ends | It stops agent runs and Candidate checks that use the same Sandbox. The 2-minute sleep stops it at no cost. |
| Run commands as root with an allowlist, as agents do | A person needs any command in a terminal. An unprivileged user per session limits what a command can reach. |
| Commit each save to the fork | Each save then costs Artifacts operations. One commit at submit costs one. |

## Consequences

- An edit session uses the same monthly Sandbox meter as agents and Candidate checks. At the cap,
  the terminal is off, and file edits and submit still work.
- A command can reach the network that the Sandbox allows. It cannot read the tokens of agents or
  Candidate checks, because those are in root process environments only.
- A session that a person leaves open ends at its next request or at the next daily sweep. Its D1
  edits stay until then. Its Sandbox sleeps 2 minutes after the last command.
