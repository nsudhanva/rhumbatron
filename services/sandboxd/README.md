# sandboxd

sandboxd runs one isolated Linux container per sandbox ID. It creates sibling containers through
the Docker Engine API, behind a socket proxy. `client.ts` exposes the subset of
`@cloudflare/sandbox` that Rhumbatron uses, so that import can resolve to it.

## Services

| Service | Image | Networks | Role |
|---|---|---|---|
| `sandboxd` | `rhumbatron/sandboxd:local` | `core`, `docker`, `sbx` | HTTP API on `:7070`. |
| `socket-proxy` | `wollomatic/socket-proxy:1.13.2` | `docker` | Allows only the Engine endpoints sandboxd uses. Rejects every bind mount. |
| `egress` | `rhumbatron/sandboxd:local` (`bun src/egress.ts`) | `sbx`, `egress_out` | HTTP(S) proxy on `:4750` with a `host:port` allowlist. |
| `sandbox-image` | `rhumbatron/sandbox:local` | none | Builds `containers/sandbox` and exits. |

`rhumbatron_sbx` is `internal: true`. A sandbox has no route out. It reaches only `egress:4750`,
`git:8080` (the git service joins `sbx` as `git`), sandboxd, and the other sandboxes. The
sandbox environment sets `HTTP_PROXY`, `HTTPS_PROXY`, and `npm_config_proxy` to the egress proxy,
and `NO_PROXY=git,localhost,127.0.0.1`. The egress allowlist is `registry.npmjs.org`,
`registry.yarnpkg.com`, `bun.sh`, `github.com`, `codeload.github.com`, and
`objects.githubusercontent.com` on 443, and `git:8080`.

Run it alone:

```sh
SANDBOXD_TOKEN=$(openssl rand -hex 24) docker compose -f services/sandboxd/compose.fragment.yml up -d --build
```

## Containers

sandboxd builds every container setting itself (`src/spec.ts`). A caller sends only a sandbox ID
and an idle time. Each container gets:

- `NanoCpus` and `Memory` = `MemorySwap` (2 CPUs, 2 GiB), `PidsLimit` 512.
- `CapDrop: ALL`, then `CHOWN`, `DAC_OVERRIDE`, `SETUID`, `SETGID`, `KILL`. Code sessions need
  these to `chown` a checkout and drop a command to a session UID with `setpriv`.
- `no-new-privileges`, no binds, no mounts, no published ports, `Init`, no restart.
- The label `rhumbatron.sandbox=<id>` and the runtime `SANDBOX_RUNTIME`.

PID 1 runs as UID 1000. Commands run as root in the container, with the capability set above,
in `/workspace` by default.

A sandbox idle for its idle time is removed with its disk, as a Cloudflare Sandbox sleeps. The
next call starts a fresh one. At most `SANDBOX_MAX` sandboxes are live. A call that needs one
more fails with `ContainerUnavailableError`. At boot sandboxd removes every container with the
label.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `SANDBOXD_TOKEN` | required | Bearer token, 16 characters or more. |
| `DOCKER_HOST` | `tcp://socket-proxy:2375` | Engine API through the socket proxy. |
| `SANDBOX_IMAGE` | `rhumbatron/sandbox:local` | Sandbox image. |
| `SANDBOX_NETWORK` | `rhumbatron_sbx` | Internal network. `host`, `bridge`, and `none` are refused. |
| `SANDBOX_RUNTIME` | `runc` | `runc`, or `runsc` (gVisor) on the Linux server. |
| `SANDBOX_IDLE_MS` | `120000` | Idle time and the cap on a caller's `sleepAfter`. |
| `SANDBOX_MAX` | `4` | Live sandboxes. |
| `SANDBOX_CPUS` | `2` | CPUs per sandbox. |
| `SANDBOX_MEMORY_MB` | `2048` | Memory per sandbox, no swap. |
| `SANDBOX_PIDS` | `512` | Process limit per sandbox. |
| `SANDBOX_EGRESS_PROXY` | `http://egress:4750` | Proxy set in the sandbox environment. |
| `SANDBOX_NO_PROXY` | `git,localhost,127.0.0.1` | Hosts reached without the proxy. |
| `SANDBOX_FILE_MAX_BYTES` | `8388608` | readFile and writeFile size cap. |
| `SANDBOX_OUTPUT_MAX_BYTES` | `8388608` | Kept bytes of stdout and of stderr per command. |
| `SANDBOX_EXEC_MAX_MS` | `1800000` | Longest command. |
| `EGRESS_ALLOW` | see above | Egress `host:port` allowlist. |
| `DOCKER_GID` | `0` | Docker socket group for the socket proxy (`0` on Docker Desktop). |

## HTTP API

Every route except `GET /healthz` needs `Authorization: Bearer $SANDBOXD_TOKEN`. Every call
starts the sandbox when it is not live. `x-sandbox-sleep-after` sets its idle time. sandboxd's own
errors carry the header `x-sandboxd-error`.

| Route | Body | Result |
|---|---|---|
| `POST /v1/sandboxes/:id` | `{ sleepAfter? }` | Create or get. |
| `DELETE /v1/sandboxes/:id` | | Remove the container and its disk. |
| `POST /v1/sandboxes/:id/exec` | `{ command, cwd?, env?, timeout? }` | `bash -c`, buffered `ExecResult`. A timeout fails with `CommandTimeoutError`. |
| `POST /v1/sandboxes/:id/files/read` | `{ path }` | `ReadFileResult`; binary content is base64. |
| `POST /v1/sandboxes/:id/files/write` | `{ path, content, encoding? }` | Atomic write through base64 chunks. |
| `POST /v1/sandboxes/:id/processes` | `{ command, cwd?, env?, processId? }` | Detached process group; output in `/tmp/.sbx-proc/<id>.out` and `.err`. |
| `GET /v1/sandboxes/:id/processes/:pid` | | Status. |
| `GET /v1/sandboxes/:id/processes/:pid/logs` | | `{ stdout, stderr }`. |
| `DELETE /v1/sandboxes/:id/processes/:pid` | | TERM, then KILL, to the process group. |
| `ANY /v1/sandboxes/:id/ports/:port/fetch/*` | | Proxies to the port on the sandbox address. |
| `PUT /v1/sandboxes/:id/env` | `{ envVars }` | Environment for later commands. |

## Client

```ts
import { getSandbox } from "@rhumbatron/sandboxd/client";

const sandbox = getSandbox({ baseUrl: "http://sandboxd:7070", token }, "proj-123", {
  sleepAfter: "2m",
});
await sandbox.exec("bun --version", { cwd: "/workspace", timeout: 60_000 });
```

`Sandbox` has `exec`, `readFile`, `writeFile`, `startProcess` (returns a process with
`waitForPort`, `getStatus`, `getLogs`, `kill`), `killProcess`, `getProcessLogs`,
`containerFetch`, `setEnvVars`, and `destroy`.

Differences from `@cloudflare/sandbox`:

- Each `exec` is a new `bash -c`. A `cd` or `export` does not carry to the next call.
- `containerFetch` reaches a server that listens on `0.0.0.0`, not one on `127.0.0.1` only.
- `keepAlive` is ignored. An idle sandbox always stops.

## Known limits

- Sandboxes share one network, so one sandbox can open connections to another.
- Docker Desktop has no per-container disk quota. A sandbox can fill the VM disk until its idle
  removal.

## Checks

```sh
cd services/sandboxd && bun run typecheck && bun run test:critical
```
