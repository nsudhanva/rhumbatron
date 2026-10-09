/**
 * Builds every Worker bundle and writes dist/bundles/manifest.json for Terraform.
 * Uses `wrangler deploy --dry-run` (local bundling only). Never deploys.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");

type Deployable = {
  name: string;
  dir: string;
  /** Directory that holds the Worker modules after build. */
  outDir: string;
  mainModule: string;
  assetsDir?: string;
};

const deployables: Deployable[] = [
  {
    name: "web",
    dir: "apps/web",
    outDir: "apps/web/dist/server",
    mainModule: "index.js",
    assetsDir: "apps/web/dist/client",
  },
  ...["api", "coordinator", "agents", "event-router", "integration", "indexer", "sandbox"].map(
    (name) => ({
      name,
      dir: `workers/${name}`,
      outDir: `workers/${name}/dist`,
      mainModule: "index.js",
    }),
  ),
];

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

async function hashFiles(files: string[], base: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(base, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Reads compatibility settings from a Worker's wrangler.jsonc so Terraform matches local dev. */
async function readWranglerConfig(dir: string) {
  const raw = await readFile(join(root, dir, "wrangler.jsonc"), "utf8");
  const json = raw.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
  const config = JSON.parse(json) as {
    compatibility_date: string;
    compatibility_flags?: string[];
  };
  return {
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags ?? [],
  };
}

function contentType(file: string): string | undefined {
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "application/javascript+module";
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".txt") || file.endsWith(".html")) return "text/plain";
  return undefined;
}

await $`bunx turbo build ${["--filter=./apps/*", "--filter=./workers/*"]}`.cwd(root);

const manifest: Record<string, unknown> = {};
for (const d of deployables) {
  const outDir = join(root, d.outDir);
  const files = await listFiles(outDir);
  const modules = files
    .filter((f) => !f.includes("/.vite/") && contentType(f))
    .map((f) => ({
      name: relative(outDir, f),
      content_file: relative(root, f),
      content_type: contentType(f),
    }));
  const assetFiles = d.assetsDir ? await listFiles(join(root, d.assetsDir)) : [];
  manifest[d.name] = {
    ...(await readWranglerConfig(d.dir)),
    main_module: d.mainModule,
    modules,
    assets_directory: d.assetsDir ?? null,
    bundle_sha256: await hashFiles([...files, ...assetFiles], root),
  };
}

await mkdir(join(root, "dist/bundles"), { recursive: true });
await writeFile(join(root, "dist/bundles/manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote dist/bundles/manifest.json for ${deployables.length} Workers.`);
