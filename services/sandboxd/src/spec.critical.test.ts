import { describe, expect, it } from "vitest";
import { containerSpec, parseCreateBody, SANDBOX_CAPS, type SandboxdConfig } from "./spec.ts";

const config: SandboxdConfig = {
  image: "rhumbatron/sandbox:local",
  network: "rhumbatron_sbx",
  runtime: "runsc",
  nanoCpus: 2e9,
  memoryBytes: 2 * 1024 ** 3,
  pidsLimit: 512,
  egressProxy: "http://egress:4750",
  noProxy: "git,localhost,127.0.0.1",
};

const hostile = {
  sleepAfter: "1m",
  Privileged: true,
  Binds: ["/:/host"],
  NetworkMode: "host",
  CapAdd: ["SYS_ADMIN"],
  HostConfig: {
    Privileged: true,
    Binds: ["/var/run/docker.sock:/var/run/docker.sock"],
    NetworkMode: "host",
    PidMode: "host",
    Mounts: [{ Type: "bind", Source: "/", Target: "/host" }],
    PortBindings: { "22/tcp": [{ HostPort: "22" }] },
  },
};

describe("sandbox container settings", () => {
  it("reads only the idle time from a create request", () => {
    const parsed = parseCreateBody(hostile, 120_000);
    expect(parsed).toEqual({ idleMs: 60_000 });
    expect(parseCreateBody({ sleepAfter: "5h" }, 120_000)).toEqual({ idleMs: 120_000 });
  });

  it("never lets caller input set Privileged, binds, or host networking", () => {
    parseCreateBody(hostile, 120_000);
    const spec = containerSpec(config, "proj-0123");
    const host = spec.HostConfig;
    expect(host.Privileged).toBe(false);
    expect(host.Binds).toEqual([]);
    expect(host.Mounts).toEqual([]);
    expect(host.VolumesFrom).toEqual([]);
    expect(host.Devices).toEqual([]);
    expect(host.NetworkMode).toBe("rhumbatron_sbx");
    expect(Object.keys(spec.NetworkingConfig.EndpointsConfig)).toEqual(["rhumbatron_sbx"]);
    expect(host.PortBindings).toEqual({});
    expect(host.PublishAllPorts).toBe(false);
    expect(host.PidMode).toBe("");
    expect(host.CapDrop).toEqual(["ALL"]);
    expect(host.CapAdd).toEqual([...SANDBOX_CAPS]);
    expect(host.CapAdd).not.toContain("SYS_ADMIN");
    expect(host.SecurityOpt).toContain("no-new-privileges:true");
    expect(host.Memory).toBe(host.MemorySwap);
    expect(host.PidsLimit).toBe(512);
    expect(host.Runtime).toBe("runsc");
    expect(spec.Labels).toEqual({ "rhumbatron.sandbox": "proj-0123" });
  });

  it("refuses a shared network, an unknown runtime, and an ID that is not a name", () => {
    for (const network of ["host", "bridge", "none", "container:abc"]) {
      expect(() => containerSpec({ ...config, network }, "proj-1")).toThrow();
    }
    expect(() => containerSpec({ ...config, runtime: "io.containerd.runc.v2" }, "x")).toThrow();
    for (const id of ["", "../etc", "a b", "-x", "a/b", "x".repeat(64)]) {
      expect(() => containerSpec(config, id)).toThrow();
    }
  });
});
