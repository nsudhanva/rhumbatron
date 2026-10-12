/** Source generation only. These programs run in a fresh Worker with no host bindings. */
const ENTRY = "__rhumbatron_check_entry.ts";
const HARNESS = "rhumbatron:test-harness";

export function unitProgram(path: string) {
  return {
    entryPoint: ENTRY,
    source: `import { runTests } from ${JSON.stringify(HARNESS)};
export default { async fetch() {
  await import(${JSON.stringify(`./${path}`)});
  return Response.json(await runTests());
} };`,
  };
}

export function testFiles(files: Record<string, string>) {
  const paths = Object.keys(files).filter((path) => !/(^|\/)(node_modules|\.git)\//.test(path));
  if (
    paths.some((path) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(path) && !path.endsWith(".test.ts"))
  ) {
    throw new Error(
      "Only *.test.ts files are supported; other test files require the project runner.",
    );
  }
  const tests = paths.filter((path) => path.endsWith(".test.ts")).sort();
  if (!tests.length || tests.length > 16)
    throw new Error("Unit check needs 1 to 16 *.test.ts files.");
  return tests;
}

/**
 * Runtime features a test can use under `bun test` that the Dynamic Worker does not have: the
 * project files on disk, the test file's own path, Bun globals, and child processes. A Dynamic
 * Worker run of such a test fails for the runner, not for the code, so the check is unsupported
 * there and the Sandbox runs the real `bun test` (a false failure would reject a good Candidate).
 */
const SANDBOX_ONLY: readonly [RegExp, string][] = [
  [/\bimport\.meta\.(dir|dirname|path|filename|file|require)\b/, "import.meta file paths"],
  [/\b__dirname\b|\b__filename\b/, "__dirname"],
  [/\bBun\.[A-Za-z]/, "Bun globals"],
  [/\bprocess\.cwd\(/, "process.cwd()"],
  [/["'](?:node:)?(?:fs|fs\/promises|child_process)["']/, "the file system or child processes"],
];

/** The Sandbox-only runtime features the given test sources use; empty when none. */
export function sandboxOnlyFeatures(sources: readonly string[]): string[] {
  return SANDBOX_ONLY.filter(([pattern]) => sources.some((source) => pattern.test(source))).map(
    ([, name]) => name,
  );
}

/**
 * Support the CONTRACT_ROOT imports of scripts/contract.ts without giving a script a filesystem. Only literal
 * `${root}/...` imports are rewritten; other dynamic paths fail closed in the Dynamic Worker.
 */
export function contractScript(source: string) {
  return source.replace(
    /import\(`\$\{root\}\/([^`$]+)`\)/g,
    (_match, path: string) => `import(${JSON.stringify(`../${path}`)})`,
  );
}

export function contractProgram(files: Record<string, string>, appModule?: string) {
  let body: string;
  if (files["scripts/contract.ts"] !== undefined) {
    body = `
const lines = [];
const write = process.stdout.write;
const log = console.log;
try {
  process.stdout.write = (text) => { lines.push(String(text)); return true; };
  console.log = (...args) => { lines.push(args.map(String).join(' ') + '\\n'); };
  await import('./scripts/contract.ts');
} finally { process.stdout.write = write; console.log = log; }
let table;
for (const line of lines.join('').split(/\\r?\\n/).reverse()) {
  try { const value = JSON.parse(line); if (Array.isArray(value.routes)) { table = value; break; } } catch {}
}
if (!table) throw new Error('Contract script produced no route table');
return Response.json(table);`;
  } else {
    const app = files["src/app.ts"] !== undefined ? "./src/app.ts" : appModule;
    if (!app) throw new Error("No app module or scripts/contract.ts.");
    body = `
const module = await import(${JSON.stringify(app)});
let app = module.default ?? module.app;
if (typeof module.createApp === 'function') {
  ${files["src/store.ts"] !== undefined ? "const { createStore } = await import('./src/store.ts'); app = module.createApp(createStore());" : "app = module.createApp();"}
}
if (!app || !Array.isArray(app.routes)) throw new Error('App does not expose a Hono route table');
const routes = app.routes.filter(r => r.method !== 'ALL').map(r => {
  if (typeof r.method !== 'string' || typeof r.path !== 'string') throw new Error('Invalid Hono route');
  return r.method + ' ' + r.path;
});
return Response.json({ routes: [...new Set(routes)].sort() });`;
  }
  return { entryPoint: ENTRY, source: `export default { async fetch() { ${body} } };` };
}

export const harnessModuleName = HARNESS;
