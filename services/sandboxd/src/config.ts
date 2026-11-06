import type { SandboxdConfig } from "./spec.ts";

const num = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
};

export type ServerConfig = SandboxdConfig & {
  token: string;
  port: number;
  dockerHost: string;
  idleMs: number;
  maxLive: number;
  fileMaxBytes: number;
  outputMaxBytes: number;
  execMaxMs: number;
};

export function loadConfig(): ServerConfig {
  const token = process.env.SANDBOXD_TOKEN ?? "";
  if (token.length < 16) throw new Error("SANDBOXD_TOKEN must be set (16 characters or more)");
  const egressProxy = process.env.SANDBOX_EGRESS_PROXY ?? "http://egress:4750";
  return {
    token,
    port: num("PORT", 7070),
    dockerHost: process.env.DOCKER_HOST ?? "tcp://socket-proxy:2375",
    image: process.env.SANDBOX_IMAGE ?? "rhumbatron/sandbox:local",
    network: process.env.SANDBOX_NETWORK ?? "rhumbatron_sbx",
    runtime: process.env.SANDBOX_RUNTIME ?? "runc",
    nanoCpus: Math.round(num("SANDBOX_CPUS", 2) * 1e9),
    memoryBytes: Math.round(num("SANDBOX_MEMORY_MB", 2048) * 1024 * 1024),
    pidsLimit: num("SANDBOX_PIDS", 512),
    egressProxy,
    noProxy: process.env.SANDBOX_NO_PROXY ?? "git,localhost,127.0.0.1",
    idleMs: num("SANDBOX_IDLE_MS", 120_000),
    maxLive: num("SANDBOX_MAX", 4),
    fileMaxBytes: num("SANDBOX_FILE_MAX_BYTES", 8 * 1024 * 1024),
    outputMaxBytes: num("SANDBOX_OUTPUT_MAX_BYTES", 8 * 1024 * 1024),
    execMaxMs: num("SANDBOX_EXEC_MAX_MS", 30 * 60_000),
  };
}
