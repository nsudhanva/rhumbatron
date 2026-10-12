// The composition build and the client-assets freshness rule (AGENTS.md sections 33, 34, 37). An
// app that builds its client must ship the bundle built from the composed sources: a Candidate
// that changes client sources but serves the old bundle fails, never passes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const BASE = "0".repeat(40);
const CS = "1".repeat(40);
const MERGED = "2".repeat(40);
const BUILT = "3".repeat(40);

const box = vi.hoisted(() => ({
  commands: [] as string[],
  head: "",
  packageJson: null as string | null,
  buildExit: 0,
}));

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: () => ({
    async exec(command: string) {
      box.commands.push(command);
      const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
      if (command.startsWith("git checkout -q -B main ")) box.head = BASE;
      if (command.startsWith("git merge ")) box.head = MERGED;
      if (command === "git rev-parse HEAD") return ok(box.head);
      if (command === "git rev-parse HEAD^{tree}") return ok("4".repeat(40));
      if (command === "cat package.json" || command.endsWith(":package.json")) {
        return box.packageJson === null
          ? { exitCode: 1, stdout: "", stderr: "no such file" }
          : ok(box.packageJson);
      }
      if (command === "bun run build") {
        return box.buildExit === 0
          ? ok("Bundled 42 modules")
          : {
              exitCode: box.buildExit,
              stdout: "",
              stderr: "error: Could not resolve './Gta6Missions'",
            };
      }
      if (command === "git status --porcelain -uall") return ok(" M public/app.js");
      if (command.startsWith("git add -A && git commit")) box.head = BUILT;
      if (command === `git diff --name-only --no-renames ${MERGED} HEAD`)
        return ok("public/app.js");
      if (command.startsWith(`git diff --name-only --no-renames ${BASE} `)) {
        const files = ["src/client/Gta6Missions.tsx", "src/app.ts"];
        if (box.head === BUILT) files.push("public/app.js");
        return ok(files.join("\n"));
      }
      if (command.endsWith(":scripts/build.ts")) {
        return ok('await Bun.build({ entrypoints: ["./src/client/main.tsx"], outdir: "public" });');
      }
      if (command.endsWith(":public/index.html")) {
        return ok(
          '<link rel="stylesheet" href="/app.css"><script type="module" src="/app.js"></script>',
        );
      }
      return ok();
    },
  }),
}));

const { composeCandidate } = await import("./candidate-sandbox.ts");
const { appBuildOutcome, appBuildScript, buildInputs, buildScriptFiles, clientAssetsOutcome } =
  await import("./app-build.ts");

const dispose = (Symbol as unknown as { dispose: symbol }).dispose;
const env = {
  SANDBOX: {},
  DB: {},
  ARTIFACTS: {
    async get(name: string) {
      return {
        async info() {
          return { remote: `https://artifacts.example/${name}.git` };
        },
        async createToken() {
          return { id: "tok", plaintext: "secret?expires=1" };
        },
        async revokeToken() {
          return true;
        },
        [dispose]() {},
      };
    },
  },
} as unknown as Parameters<typeof composeCandidate>[0];

const compose = () =>
  composeCandidate(env, {
    projectId: "proj_00000000-0000-0000-0000-000000000001",
    candidateId: "cand_abc12345",
    baseCommit: BASE,
    sources: [{ id: "cs_1", fork: "ws-1", commit: CS, files: ["src/client/Gta6Missions.tsx"] }],
    commitTime: 1_760_000_000,
  });

const WITH_BUILD = JSON.stringify({ scripts: { build: "bun scripts/build.ts", test: "bun test" } });

describe("composition build step", () => {
  beforeEach(() => {
    box.commands = [];
    box.head = "";
    box.buildExit = 0;
    box.packageJson = WITH_BUILD;
  });

  it("decides on the package.json build script", () => {
    expect(appBuildScript(WITH_BUILD)).toBe("bun scripts/build.ts");
    expect(appBuildScript(JSON.stringify({ scripts: { test: "bun test" } }))).toBeNull();
    expect(appBuildScript(JSON.stringify({ scripts: { build: " " } }))).toBeNull();
    expect(appBuildScript("{ not json")).toBeNull();
    expect(appBuildScript(null)).toBeNull();
  });

  it("with a build script: builds after the merges, commits the output, then pushes", async () => {
    const result = await compose();
    if (!result.ok) throw new Error("composition failed");
    const at = (prefix: string) => box.commands.findIndex((c) => c.startsWith(prefix));
    expect(at("git merge ")).toBeLessThan(at("bun run build"));
    expect(at("bun run build")).toBeLessThan(at("git add -A && git commit"));
    expect(at("git add -A && git commit")).toBeLessThan(
      at('git -c "http.extraHeader=$GIT_AUTH" push'),
    );
    expect(result.commit).toBe(BUILT);
    expect(result.appBuild).toMatchObject({ exitCode: 0, generated: ["public/app.js"] });
    expect(result.clientAssets).toMatchObject({ status: "pass", coverage: "checked_supported" });
  });

  it("without a build script: no build runs and no build result exists", async () => {
    box.packageJson = JSON.stringify({ scripts: { test: "bun test" } });
    const result = await compose();
    if (!result.ok) throw new Error("composition failed");
    expect(box.commands).not.toContain("bun run build");
    expect(result.commit).toBe(MERGED);
    expect(result.appBuild).toBeUndefined();
    expect(result.clientAssets).toBeUndefined();
  });

  it("a failing build commits nothing and becomes failing build Evidence", async () => {
    box.buildExit = 1;
    const result = await compose();
    if (!result.ok || !result.appBuild) throw new Error("expected a build result");
    expect(box.commands.some((c) => c.startsWith("git add -A && git commit"))).toBe(false);
    expect(result.commit).toBe(MERGED);
    expect(appBuildOutcome(result.appBuild)).toMatchObject({
      status: "fail",
      coverage: "checked_supported",
    });
    expect(appBuildOutcome(result.appBuild).summary).toContain("Could not resolve");
    // The sources changed and the bundle did not: the freshness rule fails too.
    expect(result.clientAssets?.status).toBe("fail");
  });

  it("a build timeout or Sandbox error is a gap, never a pass", () => {
    const run = { output: "", generated: [], startedAt: "", completedAt: "" };
    expect(appBuildOutcome({ ...run, exitCode: null, timedOut: true })).toMatchObject({
      status: "error",
      coverage: "not_checked",
    });
    expect(
      appBuildOutcome({ ...run, exitCode: null, timedOut: false, error: "lost" }),
    ).toMatchObject({
      status: "error",
      coverage: "not_checked",
    });
  });
});

describe("client-assets freshness rule", () => {
  const INDEX = '<link rel="stylesheet" href="app.css"><script src="/app.js"></script>';
  const inputs = buildInputs([]);

  it("fails when client sources changed but the referenced assets did not", () => {
    const outcome = clientAssetsOutcome({
      changed: ["src/client/Gta6Missions.tsx", "src/app.ts"],
      indexHtml: INDEX,
      inputs,
    });
    expect(outcome).toMatchObject({ status: "fail", coverage: "checked_supported" });
    expect(outcome.summary).toContain(
      "public/app.css, public/app.js referenced by public/index.html",
    );
    expect(outcome.summary).toContain("old bundle");
  });

  it("passes when a referenced asset changed, or when no client source changed", () => {
    expect(
      clientAssetsOutcome({
        changed: ["src/client/Gta6Missions.tsx", "public/app.js"],
        indexHtml: INDEX,
        inputs,
      }).status,
    ).toBe("pass");
    expect(
      clientAssetsOutcome({ changed: ["src/app.ts", "test/a.test.ts"], indexHtml: INDEX, inputs })
        .status,
    ).toBe("pass");
  });

  it("counts the src/ paths that the build script names as client sources", () => {
    const files = buildScriptFiles("bun scripts/build.ts && tailwindcss -i src/styles.css");
    expect(files).toEqual(["scripts/build.ts"]);
    const named = buildInputs([
      'Bun.build({ entrypoints: ["./src/web/main.tsx"] }); await css("src/styles.css");',
    ]);
    expect(named).toEqual(["src/client/", "src/styles.css", "src/web/", "src/web/main.tsx"]);
    // A file directly under src/ adds only itself: server code there is not a client source.
    expect(
      clientAssetsOutcome({ changed: ["src/app.ts"], indexHtml: INDEX, inputs: named }).status,
    ).toBe("pass");
    expect(
      clientAssetsOutcome({ changed: ["src/web/List.tsx"], indexHtml: INDEX, inputs: named })
        .status,
    ).toBe("fail");
  });

  it("passes with the reason when the page has no local asset to compare", () => {
    const changed = ["src/client/a.tsx"];
    expect(clientAssetsOutcome({ changed, indexHtml: null, inputs }).summary).toContain(
      "No public/index.html",
    );
    expect(
      clientAssetsOutcome({ changed, indexHtml: '<script src="https://cdn.example/x.js">', inputs })
        .summary,
    ).toContain("references no local script or style");
  });
});
