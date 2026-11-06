/**
 * Bundles workers/apps for workerd: one ES module (`worker.js`) plus `esbuild.wasm`, which
 * @cloudflare/worker-bundler imports at run time. Output: services/apps/dist (or argv[2]).
 *
 *   bun services/apps/build.ts [outdir]
 */
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const outdir = resolve(process.argv[2] ?? join(import.meta.dir, "dist"));
const entry = join(root, "workers/apps/src/platform/workerd.ts");

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [entry],
  outdir,
  naming: "worker.js",
  target: "browser",
  format: "esm",
  conditions: ["workerd", "worker", "browser"],
  external: ["cloudflare:*", "node:*", "*.wasm"],
  minify: { syntax: true, whitespace: true, identifiers: false },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// The wasm file next to the module that imports it: "./esbuild.wasm" resolves to "esbuild.wasm".
const bundler = Bun.resolveSync("@cloudflare/worker-bundler", join(root, "workers/apps"));
copyFileSync(join(dirname(bundler), "esbuild.wasm"), join(outdir, "esbuild.wasm"));
console.log(`bundled ${entry} -> ${outdir}`);
