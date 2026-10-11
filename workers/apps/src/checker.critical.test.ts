import { describe, expect, it, vi } from "vitest";
import { contractScript, testFiles } from "./checker-program.ts";
import { mapCheckResult } from "./checker-result.ts";
import { type CheckDependencies, runAppCheck, withCheckDeadline } from "./checker-runner.ts";
import { checkSourceManifest, readCheckSource, validateCheckSource } from "./checker-source.ts";

const good = { passed: 1, failed: 0, failures: [], unsupported: [] };
const bad = {
  passed: 0,
  failed: 1,
  failures: [{ name: "unit", message: "wrong" }],
  unsupported: [],
};
const code = { mainModule: "index.js", modules: { "index.js": "export default {}" } };
const runtime = (reply: unknown): CheckDependencies => ({
  build: vi.fn(async () => code),
  bundle: vi.fn(async () => code),
  execute: vi.fn(async () => reply),
});

describe("check coverage mapping", () => {
  it("only completed positive checks are supported passes", () => {
    for (const [kind, report] of [
      ["build", { loaded: true }],
      ["unit", good],
      ["contract", { routes: ["GET /", "POST /api/cart"] }],
    ] as const) {
      expect(mapCheckResult(kind, [report])).toMatchObject({
        status: "pass",
        coverage: "checked_supported",
        exitCode: 0,
        supported: true,
      });
    }
    expect(
      JSON.parse(mapCheckResult("contract", [{ routes: ["GET /b", "GET /a", "GET /a"] }]).output),
    ).toEqual({ routes: ["GET /a", "GET /b"] });
    expect(mapCheckResult("contract", [{ routes: [] }]).status).toBe("pass");
  });

  it("marks failures, missing tests, skipped APIs, and malformed reports as gaps", () => {
    expect(mapCheckResult("unit", [good, bad])).toMatchObject({
      status: "fail",
      coverage: "not_checked",
      supported: true,
      passed: 1,
      failed: 1,
      exitCode: 1,
    });
    for (const report of [
      null,
      {},
      { ...good, passed: 0 },
      { ...good, unsupported: ["test.skip"] },
      { ...bad, failures: [] },
      { ...good, passed: -1 },
      { ...good, passed: 1.5 },
    ]) {
      expect(mapCheckResult("unit", [report])).toMatchObject({
        status: "error",
        coverage: "not_checked",
        exitCode: null,
        supported: false,
      });
    }
    expect(mapCheckResult("unit", [good, { ...good, passed: 0 }]).status).toBe("error");
    expect(mapCheckResult("unit", []).status).toBe("error");
    expect(mapCheckResult("build", [{ loaded: false }]).coverage).toBe("not_checked");
    for (const routes of [[42], ["GET bad"], ["GET /\nPOST /hidden"]]) {
      expect(mapCheckResult("contract", [{ routes }]).coverage).toBe("not_checked");
    }
  });
});

describe("check orchestration", () => {
  it("checks module loading after the existing builder, without calling app fetch", async () => {
    const deps = runtime({ loaded: true });
    expect((await runAppCheck("build", {}, deps)).status).toBe("pass");
    expect(deps.build).toHaveBeenCalledOnce();
    const sent = vi.mocked(deps.execute).mock.calls[0]?.[0];
    expect(sent?.mainModule).toBe("__rhumbatron_check_load.js");
    expect(sent?.modules[sent.mainModule]).toContain('import("./index.js")');
    expect(sent?.modules[sent.mainModule]).not.toContain(".fetch(");
  });

  it("bundles every test separately with the bun:test alias and accumulates failures", async () => {
    const deps = runtime(good);
    vi.mocked(deps.execute).mockResolvedValueOnce(bad);
    const result = await runAppCheck("unit", { "test/a.test.ts": "", "src/b.test.ts": "" }, deps);
    expect(result).toMatchObject({ status: "fail", passed: 1, failed: 1, coverage: "not_checked" });
    expect(deps.bundle).toHaveBeenCalledTimes(2);
    const options = vi.mocked(deps.bundle).mock.calls[0]?.[0];
    expect(options?.virtualModules?.["bun:test"]).toContain("beforeEach");
    expect(options?.files[options.entryPoint]).toContain("await import");
  });

  it("falls back on an unsupported file or runtime rather than passing a partial suite", async () => {
    const deps = runtime(good);
    expect((await runAppCheck("unit", {}, deps)).supported).toBe(false);
    expect(deps.bundle).not.toHaveBeenCalled();
    expect(() => testFiles({ "a.test.ts": "", "b.spec.ts": "" })).toThrow();
    expect(() =>
      testFiles(Object.fromEntries(Array.from({ length: 17 }, (_, n) => [`${n}.test.ts`, ""]))),
    ).toThrow();
    vi.mocked(deps.execute).mockRejectedValue(new Error("CPU limit exceeded"));
    expect(await runAppCheck("unit", { "a.test.ts": "" }, deps)).toMatchObject({
      coverage: "not_checked",
      exitCode: null,
      supported: false,
    });
    vi.mocked(deps.build).mockRejectedValue(new Error("native dependency"));
    expect((await runAppCheck("build", {}, deps)).coverage).toBe("not_checked");
  });

  it("leaves tests that read files or use Bun globals to the Sandbox, never a false failure", async () => {
    const deps = runtime(bad);
    for (const source of [
      'readFileSync(join(import.meta.dir, "..", "public", "index.html"), "utf8")',
      'import { readFile } from "node:fs/promises";',
      'const html = await Bun.file("public/index.html").text();',
      'path.resolve(__dirname, "../public")',
      'spawnSync("bun", ["run", "build"]); import { spawnSync } from "child_process";',
    ]) {
      expect(await runAppCheck("unit", { "test/a.test.ts": source }, deps)).toMatchObject({
        status: "error",
        coverage: "not_checked",
        supported: false,
      });
    }
    expect(deps.bundle).not.toHaveBeenCalled();
    const plain = 'import { createApp } from "../src/app.ts"; expect(await res.json()).toBe(1);';
    expect((await runAppCheck("unit", { "test/a.test.ts": plain }, deps)).supported).toBe(true);
  });

  it("runs a contract script when present and otherwise reads the Hono factory", async () => {
    const deps = runtime({ routes: ["GET /api/cart"] });
    expect(
      (
        await runAppCheck(
          "contract",
          {
            "scripts/contract.ts":
              "const {createApp} = await import(`" + "${" + "root}/src/app.ts`);",
          },
          deps,
        )
      ).output,
    ).toBe('{"routes":["GET /api/cart"]}');
    const options = vi.mocked(deps.bundle).mock.calls[0]?.[0];
    expect(options?.files["scripts/contract.ts"]).toContain('import("../src/app.ts")');
    expect(options?.files[options.entryPoint]).toContain("process.stdout.write");
    await runAppCheck("contract", { "src/app.ts": "", "src/store.ts": "" }, deps);
    const factory = vi.mocked(deps.bundle).mock.calls[1]?.[0];
    expect(factory?.files[factory.entryPoint]).toContain("module.createApp(createStore())");
    expect(factory?.files[factory.entryPoint]).toContain("r.method !== 'ALL'");
    await runAppCheck("contract", { "src/index.ts": "" }, deps);
    expect(deps.build).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.execute).mock.calls[2]?.[0].modules["index.js"]).toBe(
      code.modules["index.js"],
    );
    expect(contractScript("await import(`" + "${" + "other}/src/app.ts`)")).toBe(
      "await import(`" + "${" + "other}/src/app.ts`)",
    );
  });

  it("does not allow a timeout to become a pass and clears the deadline", async () => {
    vi.useFakeTimers();
    try {
      const work = withCheckDeadline(() => new Promise<string>(() => {}), 5);
      const rejected = expect(work).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(5);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
      expect(await withCheckDeadline(async () => "done", 5)).toBe("done");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

const tree = "a".repeat(40);
const manifest = {
  treeSha: tree,
  commit: "b".repeat(40),
  complete: true,
  entries: [{ path: "test/a.test.ts", blob: "c".repeat(40), size: 0, stored: true }],
};
describe("source boundary", () => {
  it("rejects missing, mismatched, incomplete, native, oversized and ambiguous trees", () => {
    validateCheckSource("proj_demo", tree);
    expect(() => validateCheckSource("../other", tree)).toThrow();
    expect(checkSourceManifest(manifest, tree).entries).toHaveLength(1);
    for (const value of [
      null,
      { ...manifest, complete: false },
      { ...manifest, treeSha: "d".repeat(40) },
      { ...manifest, entries: [...manifest.entries, ...manifest.entries] },
    ]) {
      expect(() => checkSourceManifest(value, tree)).toThrow();
    }
    for (const path of [
      "../app.ts",
      "/app.ts",
      "src/./app.ts",
      "src\\app.ts",
      "__rhumbatron_check_entry.ts",
      "dep.node",
    ]) {
      expect(() =>
        checkSourceManifest({ ...manifest, entries: [{ ...manifest.entries[0], path }] }, tree),
      ).toThrow();
    }
    for (const entry of [{ stored: false }, { size: null }, { size: 1048577 }]) {
      expect(() =>
        checkSourceManifest({ ...manifest, entries: [{ ...manifest.entries[0], ...entry }] }, tree),
      ).toThrow();
    }
  });

  it("fails closed on a missing R2 manifest", async () => {
    const get = vi.fn(async () => null);
    await expect(readCheckSource({ get }, "proj_demo", tree)).rejects.toThrow("Missing");
    expect(get).toHaveBeenCalledWith(`source/proj_demo/${tree}/code.json`);
  });
});
