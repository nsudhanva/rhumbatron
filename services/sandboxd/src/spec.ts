/**
 * Pure container settings for one sandbox. sandboxd builds every HostConfig here, from its own
 * configuration only. No caller field reaches Docker: the API accepts a sandbox ID and an idle
 * time, and nothing else shapes the container.
 */

/** The label every sandbox container carries. The boot sweep removes all containers with it. */
export const SANDBOX_LABEL = "rhumbatron.sandbox";

/** Linux capabilities a sandbox keeps after `CapDrop: ALL`. */
export const SANDBOX_CAPS = [
  // Root in the container owns the checkouts: code sessions `chown` a checkout to a session UID.
  "CHOWN",
  // Root in the container reads and writes files that a session UID owns.
  "DAC_OVERRIDE",
  // `setpriv --reuid/--regid` drops a session command to its own UID and GID.
  "SETUID",
  "SETGID",
  // `killProcess` and code sessions signal processes of another UID.
  "KILL",
] as const;

export type SandboxdConfig = {
  image: string;
  network: string;
  runtime: string;
  nanoCpus: number;
  memoryBytes: number;
  pidsLimit: number;
  egressProxy: string;
  noProxy: string;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
/** Network modes that share the host's or another container's network, or the default bridge. */
const SHARED_NETWORKS = /^(host|bridge|default|none|container:.*|service:.*)$/;
const RUNTIMES = new Set(["runc", "runsc"]);

/** True for a sandbox ID that can name a container. */
export const validSandboxId = (id: string) => ID.test(id);

export const containerName = (id: string) => `rhumbatron-sbx-${id}`;

/** The body of `POST /containers/create` for sandbox `id`. Throws on an invalid ID. */
export function containerSpec(config: SandboxdConfig, id: string) {
  if (!validSandboxId(id)) throw new Error(`invalid sandbox id ${JSON.stringify(id)}`);
  if (SHARED_NETWORKS.test(config.network)) {
    throw new Error(`sandbox network ${config.network} is not an isolated network`);
  }
  if (!RUNTIMES.has(config.runtime)) throw new Error(`unknown runtime ${config.runtime}`);
  const proxy = config.egressProxy;
  return {
    name: containerName(id),
    Image: config.image,
    // PID 1 holds the container open as the unprivileged image user; work runs through exec.
    Cmd: ["sleep", "infinity"],
    User: "1000:1000",
    WorkingDir: "/workspace",
    Hostname: "sandbox",
    Labels: { [SANDBOX_LABEL]: id },
    Env: [
      `HTTP_PROXY=${proxy}`,
      `HTTPS_PROXY=${proxy}`,
      `http_proxy=${proxy}`,
      `https_proxy=${proxy}`,
      `npm_config_proxy=${proxy}`,
      `npm_config_https_proxy=${proxy}`,
      `NO_PROXY=${config.noProxy}`,
      `no_proxy=${config.noProxy}`,
    ],
    ExposedPorts: {},
    NetworkingConfig: { EndpointsConfig: { [config.network]: {} } },
    HostConfig: {
      NetworkMode: config.network,
      Runtime: config.runtime,
      NanoCpus: config.nanoCpus,
      Memory: config.memoryBytes,
      MemorySwap: config.memoryBytes,
      PidsLimit: config.pidsLimit,
      CapDrop: ["ALL"],
      CapAdd: [...SANDBOX_CAPS],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      Init: true,
      Binds: [],
      Mounts: [],
      VolumesFrom: [],
      Devices: [],
      PortBindings: {},
      PublishAllPorts: false,
      IpcMode: "private",
      PidMode: "",
      UsernsMode: "",
      ReadonlyRootfs: false,
      RestartPolicy: { Name: "no" },
      LogConfig: { Type: "none", Config: {} },
    },
  };
}

/** Parses `sleepAfter` ("30s", "2m", "1h", or seconds). Null when absent or invalid. */
function parseSleepAfter(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value * 1000 : null;
  if (typeof value !== "string") return null;
  const m = /^(\d+)\s*(s|m|h)?$/.exec(value.trim());
  if (!m) return null;
  const unit = m[2] === "h" ? 3_600_000 : m[2] === "m" ? 60_000 : 1000;
  return Number(m[1]) * unit;
}

/**
 * The create-or-get request. Only `sleepAfter` is read; every other field is ignored, so a caller
 * can never set container settings.
 */
export function parseCreateBody(body: unknown, maxIdleMs: number): { idleMs: number } {
  const raw =
    body && typeof body === "object" ? (body as { sleepAfter?: unknown }).sleepAfter : undefined;
  const asked = parseSleepAfter(raw);
  return { idleMs: Math.min(asked ?? maxIdleMs, maxIdleMs) };
}
