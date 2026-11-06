/**
 * Publishes the docs site to https://rhumbatron.com.
 *
 * The site is a Cloudflare Worker with static assets only (`rhumbatron-docs`). Requests for static
 * assets are free and do not count against the Workers request limit.
 *
 * 1. Builds apps/docs with DOCS_SITE=https://rhumbatron.com.
 * 2. Copies the build to a deploy folder outside the repository, with the Worker configuration.
 * 3. Installs `cf` and `wrangler` there, then runs `cf deploy`. The `cf` CLI must be logged in to the Cloudflare account.
 *
 * The deploy folder is outside the workspace, so `cf` sees a plain static site and does not
 * change the Astro project.
 */
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";

const SITE = "https://rhumbatron.com";
const root = resolve(import.meta.dir, "..");
const docs = join(root, "apps/docs");
const deployDir = join(tmpdir(), "rhumbatron-docs-deploy");

await $`bun run build`.cwd(docs).env({ ...process.env, DOCS_SITE: SITE });

await mkdir(deployDir, { recursive: true });
await rm(join(deployDir, "dist"), { recursive: true, force: true });
await cp(join(docs, "dist"), join(deployDir, "dist"), { recursive: true });

const files: Record<string, string> = {
  "package.json": `${JSON.stringify(
    {
      name: "rhumbatron-docs",
      private: true,
      type: "module",
      devDependencies: { cf: "^1.0.0-beta.28", wrangler: "^4.158.0" },
      scripts: { deploy: "cf deploy" },
    },
    null,
    2,
  )}\n`,
  "cloudflare.config.ts": `import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "rhumbatron-docs",
    compatibilityDate: "2026-10-01",
    assets: { htmlHandling: "auto-trailing-slash", notFoundHandling: "404-page" },
    domains: ["${new URL(SITE).host}"],
    observability: { enabled: false },
  },
});
`,
  "wrangler.config.ts": `import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({ assetsDirectory: "dist" });
`,
};
for (const [name, text] of Object.entries(files)) await writeFile(join(deployDir, name), text);

await $`bun install --silent`.cwd(deployDir);
await $`cf deploy`.cwd(deployDir);

const res = await fetch(SITE, { redirect: "manual" });
if (res.status !== 200) {
  console.error(`${SITE} returned ${res.status} after the deploy.`);
  process.exit(1);
}
console.log(`The docs site is live at ${SITE}.`);
