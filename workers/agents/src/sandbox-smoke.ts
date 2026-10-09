import type { ProjectRootDO } from "@rhumbatron/coordinator";
import { closeWorkspace, openWorkspace, runCommand, type WorkspaceRef } from "./workspace.ts";

/**
 * Integration smoke check "Sandbox executes Bun" (AGENTS.md section 49.3), with no model calls:
 * fork the canonical repo, check it out in the Project Sandbox, run the fixture tests, then close
 * the workspace and delete the fork so nothing is left behind.
 */
export type SandboxSmokeResult = {
  ok: boolean;
  steps: { step: string; ok: boolean; ms: number; detail: string }[];
};

export async function sandboxSmoke(env: Env, projectId: string): Promise<SandboxSmokeResult> {
  const steps: SandboxSmokeResult["steps"] = [];
  const step = async (name: string, fn: () => Promise<string>) => {
    const started = Date.now();
    try {
      const detail = await fn();
      steps.push({ step: name, ok: true, ms: Date.now() - started, detail: detail.slice(-1500) });
      return detail;
    } catch (error) {
      steps.push({
        step: name,
        ok: false,
        ms: Date.now() - started,
        detail: String(error).slice(0, 500),
      });
      throw error;
    }
  };

  const root = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  const canonical = await root.get(root.idFromName(projectId)).getCanonical();
  if (!canonical || canonical.artifactRef === "unassigned") {
    return {
      ok: false,
      steps: [{ step: "source", ok: false, ms: 0, detail: "Project has no source" }],
    };
  }
  const index = await env.EVIDENCE.get(`source/${projectId}/${canonical.treeSha}/index.json`);
  const commit = index ? ((await index.json()) as { commit: string }).commit : "";
  const runId = `run_smoke-${Date.now().toString(36)}`;
  let ws: WorkspaceRef | null = null;
  try {
    const opening = Date.now();
    const result = await openWorkspace(env, { projectId, runId, baseCommit: commit }).catch(
      (error: unknown) => {
        steps.push({
          step: "open (fork, clone, bun install)",
          ok: false,
          ms: Date.now() - opening,
          detail: String(error).slice(0, 800),
        });
        throw error;
      },
    );
    if ("refused" in result)
      return {
        ok: false,
        steps: [{ step: "open", ok: false, ms: 0, detail: result.message }],
      };
    ws = result;
    const opened = result;
    steps.push({
      step: "open (fork, clone, bun install)",
      ok: true,
      ms: Date.now() - opened.openedAt,
      detail: opened.fork,
    });
    await step("bun --version", () =>
      runCommand(env, opened, "bun test --help").then((o) => o.split("\n")[0] ?? ""),
    );
    const tests = await step("bun test", () => runCommand(env, opened, "bun test"));
    if (!tests.startsWith("exit 0")) throw new Error("bun test failed");
    await step("bun run typecheck", () => runCommand(env, opened, "bun run typecheck"));
    return { ok: steps.every((s) => s.ok), steps };
  } catch {
    return { ok: false, steps };
  } finally {
    if (ws) {
      await closeWorkspace(env, ws);
      await env.ARTIFACTS.delete(ws.fork).catch(() => false);
    }
  }
}
