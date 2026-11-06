/**
 * Publishes the docs site to https://rhumbatron.com from this computer.
 *
 * The `docs` GitHub workflow publishes the site after each push to main that changes it. Use this
 * script to publish without a push.
 *
 * The site is a Cloudflare Worker with static assets only (`rhumbatron-docs`). Requests for static
 * assets are free and do not count against the Workers request limit. apps/docs/wrangler.json
 * holds the Worker configuration for both paths.
 *
 * 1. Builds apps/docs with DOCS_SITE=https://rhumbatron.com.
 * 2. Copies the build to a deploy folder outside the repository, with the Worker configuration.
 * 3. Installs `cf` and `wrangler` there, then runs `cf deploy`. The `cf` CLI must be logged in.
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
const worker = (await Bun.file(join(docs, "wrangler.json")).json()) as {
  name: string;
  compatibility_date: string;
  assets: { html_handling: string; not_found_handling: string };
  routes: { pattern: string; custom_domain: boolean }[];
};
const deployDir = join(tmpdir(), "rhumbatron-docs-deploy");

await $`bun run build`.cwd(docs).env({ ...process.env, DOCS_SITE: SITE });

await mkdir(deployDir, { recursive: true });
await rm(join(deployDir, "dist"), { recursive: true, force: true });
await cp(join(docs, "dist"), join(deployDir, "dist"), { recursive: true });

const files: Record<string, string> = {
  "package.json": `${JSON.stringify(
    {
      name: worker.name,
      private: true,
      type: "module",
      devDependencies: { cf: "^1.0.0-beta.28", wrangler: "^4.158.0" },
      scripts: { deploy: "cf deploy" },
    },
    null,
    2,
  )}\n`,
  "cloudflare.config.ts": `import { defineConfig } from "cf/config";

export default defineConfig(${JSON.stringify(
    {
      worker: {
        name: worker.name,
        compatibilityDate: worker.compatibility_date,
        assets: {
          htmlHandling: worker.assets.html_handling,
          notFoundHandling: worker.assets.not_found_handling,
        },
        domains: worker.routes.filter((r) => r.custom_domain).map((r) => r.pattern),
        observability: { enabled: false },
      },
    },
    null,
    2,
  )});
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
