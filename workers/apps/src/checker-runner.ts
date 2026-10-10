import {
  contractProgram,
  contractScript,
  harnessModuleName,
  testFiles,
  unitProgram,
} from "./checker-program.ts";
import {
  type AppCheckKind,
  type AppCheckResult,
  checkGap,
  mapCheckResult,
} from "./checker-result.ts";
import { testHarnessSource } from "./test-harness.ts";

type CheckModules = { mainModule: string; modules: Record<string, string | WorkerLoaderModule> };
type BundleOptions = {
  files: Record<string, string>;
  entryPoint: string;
  virtualModules?: Record<string, string>;
};
export type CheckDependencies = {
  /** The existing AppBuilder, including its real-auth policy and source filters. */
  build(): Promise<CheckModules>;
  bundle(options: BundleOptions): Promise<CheckModules>;
  execute(code: CheckModules): Promise<unknown>;
};

/** Deadline covers source reads, bundling, and execution. A late result never becomes evidence. */
export async function withCheckDeadline<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Check timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Pure orchestration, injectable runtime boundaries. No workerd import in critical tests. */
export async function runAppCheck(
  kind: AppCheckKind,
  files: Record<string, string>,
  deps: CheckDependencies,
): Promise<AppCheckResult> {
  try {
    if (kind === "build") {
      const code = await deps.build();
      const mainModule = "__rhumbatron_check_load.js";
      if (code.modules[mainModule]) throw new Error("Reserved module name.");
      const modules = {
        ...code.modules,
        [mainModule]: `export default { async fetch() {
await import(${JSON.stringify(`./${code.mainModule}`)});
return Response.json({ loaded: true }); } };`,
      };
      return mapCheckResult(kind, [await deps.execute({ mainModule, modules })]);
    }
    if (kind === "unit") {
      const reports: unknown[] = [];
      const paths = testFiles(files);
      const virtualModules = {
        [harnessModuleName]: testHarnessSource(),
        "bun:test": `export { describe, it, test, expect, beforeEach, afterEach } from ${JSON.stringify(harnessModuleName)};`,
      };
      for (const path of paths) {
        const program = unitProgram(path);
        const code = await deps.bundle({
          files: { ...files, [program.entryPoint]: program.source },
          entryPoint: program.entryPoint,
          virtualModules,
        });
        const report = await deps.execute(code);
        reports.push(report);
        const mapped = mapCheckResult(kind, [report]);
        if (!mapped.supported) return mapCheckResult(kind, reports);
      }
      return mapCheckResult(kind, reports);
    }
    let app: CheckModules | undefined;
    if (files["scripts/contract.ts"] === undefined && files["src/app.ts"] === undefined)
      app = await deps.build();
    const program = contractProgram(files, app ? `./${app.mainModule}` : undefined);
    if (app) {
      const mainModule = "__rhumbatron_check_contract.js";
      if (app.modules[mainModule]) throw new Error("Reserved module name.");
      return mapCheckResult(kind, [
        await deps.execute({
          mainModule,
          modules: { ...app.modules, [mainModule]: program.source },
        }),
      ]);
    }
    const sources = { ...files, [program.entryPoint]: program.source };
    if (sources["scripts/contract.ts"] !== undefined)
      sources["scripts/contract.ts"] = contractScript(sources["scripts/contract.ts"]);
    // Contract scripts use process.stdout; the compatibility flag is set by the entrypoint.
    const code = await deps.bundle({ files: sources, entryPoint: program.entryPoint });
    return mapCheckResult(kind, [await deps.execute(code)]);
  } catch (error) {
    const reason = String(error);
    return checkGap(kind, reason, /timed out|timeout/i.test(reason));
  }
}
