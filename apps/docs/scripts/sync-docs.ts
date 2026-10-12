/**
 * Generates Starlight pages from the repository docs/ folder, the single source of truth.
 * Adds frontmatter (title from the first heading, sidebar order), rewrites relative links to site
 * URLs, and turns ```mermaid fences into <pre class="mermaid"> for client-side rendering.
 * Output: src/content/docs/ (gitignored). Runs before `astro dev` and `astro build`.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, resolve } from "node:path";

const appRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(appRoot, "../..");
const docsRoot = join(repoRoot, "docs");
const outRoot = join(appRoot, "src/content/docs");
const repoUrl = "https://github.com/nsudhanva/rhumbatron/blob/main";

/** docs/ subfolders published on the site. */
const sections = ["architecture", "operations", "demo", "adr", "protocols"];

type Page = {
  /** Source path relative to the repository root, for example docs/adr/0001-x.md. */
  source: string;
  /** Output path relative to src/content/docs, for example adr/0001-x.md. */
  output: string;
  frontmatter: Record<string, unknown>;
  body: string;
};

/** Site URL for an output path: adr/0001-x.md -> /adr/0001-x/, architecture/index.md -> /architecture/. */
function siteUrl(output: string): string {
  const path = output.replace(/\.md$/, "").replace(/(^|\/)index$/, "");
  return path ? `/${path}/` : "/";
}

/** Maps a repository-relative docs path to its output path, or null when it is not published. */
function outputFor(source: string): string | null {
  if (source === "README.md") return "index.md";
  if (source === "docs/BUILD_STATUS.md") return "build-status.md";
  const match = /^docs\/([^/]+)\/(.+)\.md$/.exec(source);
  if (!match?.[1] || !match[2] || !sections.includes(match[1])) return null;
  const name = match[2] === "README" ? "index" : match[2];
  return `${match[1]}/${name}.md`;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Applies `fn` to text outside fenced code blocks, and turns mermaid fences into diagrams. */
function transformBody(body: string, fn: (text: string) => string): string {
  const fence = /^(```|~~~)([^\n]*)\n([\s\S]*?)^\1[ \t]*$/gm;
  let out = "";
  let last = 0;
  for (const match of body.matchAll(fence)) {
    out += fn(body.slice(last, match.index));
    const [block, , info = "", code = ""] = match;
    out +=
      info.trim() === "mermaid"
        ? `<pre class="mermaid not-content">${escapeHtml(code.trimEnd())}</pre>`
        : block;
    last = match.index + block.length;
  }
  return out + fn(body.slice(last));
}

/** Rewrites relative Markdown links: published docs to site URLs, everything else to GitHub. */
function rewriteLinks(text: string, source: string): string {
  return text.replace(/\]\(([^)\s]+)\)/g, (whole, target: string) => {
    if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return whole;
    const [path = "", hash] = target.split("#");
    const resolved = posix.normalize(posix.join(posix.dirname(source), path));
    if (resolved.startsWith("..")) return whole;
    const output = outputFor(resolved);
    const anchor = hash ? `#${hash}` : "";
    if (output) return `](${siteUrl(output)}${anchor})`;
    return `](${repoUrl}/${resolved}${anchor})`;
  });
}

/** Splits off the first `# Heading` as the title and returns the rest as the body. */
function splitTitle(markdown: string, source: string): { title: string; body: string } {
  const match = /^#\s+(.+?)\s*#*\s*$/m.exec(markdown);
  if (!match?.[1]) throw new Error(`${source}: no top-level heading for the page title`);
  const title = match[1].replace(/`/g, "");
  return { title, body: markdown.slice(match.index + match[0].length).replace(/^\s+/, "") };
}

/** Keeps the README parts that describe the product; setup and command tables live elsewhere. */
function landingBody(readme: string): string {
  const keep = new Set(["How it works", "Key Features", "Built on Cloudflare"]);
  const [intro = "", ...rest] = readme.split(/^(?=## )/m);
  const kept = rest.filter((part) => keep.has(/^## (.+)$/m.exec(part)?.[1]?.trim() ?? ""));
  const links = [
    "## Explore",
    "",
    "- [Architecture](/architecture/): how a goal becomes one verified canonical future.",
    "- [Operations](/operations/): deploy, release, costs, pause and resume, cleanup, naming.",
    "- [Demo](/demo/): the Wishlist runbook, the Wishlist fixture, and the shared requests demo.",
    "- [Decisions](/adr/): the architecture decision records.",
    "- [Protocols](/protocols/): the protocol schemas and the API routes.",
    "- [Build status](/build-status/): current phase and progress.",
    "",
  ].join("\n");
  return [intro.trimEnd(), "", ...kept.map((part) => part.trimEnd()), "", links].join("\n");
}

async function listMarkdown(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => relative(repoRoot, join(e.parentPath, e.name)).split("\\").join("/"))
    .sort();
}

function sidebarFor(source: string, output: string, title: string, index: number) {
  if (output.endsWith("/index.md")) return { order: 0, label: "Overview" };
  const adr = /^docs\/adr\/(\d+)-/.exec(source);
  if (adr?.[1])
    return { order: Number(adr[1]), label: `${adr[1]} ${title.replace(/^ADR \d+:\s*/, "")}` };
  return { order: index + 1 };
}

function toMarkdown(page: Page): string {
  // JSON values are valid YAML, so titles with colons or quotes need no extra escaping.
  const yaml = Object.entries(page.frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  const generated = `<!-- Generated by apps/docs/scripts/sync-docs.ts from ${page.source}. Edit the source. -->`;
  return `---\n${yaml.join("\n")}\n---\n\n${generated}\n\n${page.body.trimEnd()}\n`;
}

const pages: Page[] = [];
const sources = (await listMarkdown(docsRoot)).filter((s) => outputFor(s));
for (const [index, source] of sources.entries()) {
  const output = outputFor(source);
  if (!output) continue;
  const { title, body } = splitTitle(await readFile(join(repoRoot, source), "utf8"), source);
  const frontmatter: Record<string, unknown> = { title };
  if (output !== "build-status.md") frontmatter.sidebar = sidebarFor(source, output, title, index);
  pages.push({ source, output, frontmatter, body });
}

const readme = splitTitle(await readFile(join(repoRoot, "README.md"), "utf8"), "README.md");
// The first sentence of the README intro paragraph.
const tagline = /^(Rhumbatron [^.]+\.)/m.exec(readme.body)?.[1] ?? "";
pages.push({
  source: "README.md",
  output: "index.md",
  frontmatter: {
    title: readme.title,
    description: tagline,
    template: "splash",
    hero: {
      tagline,
      actions: [
        { text: "Read the architecture", link: "/architecture/", icon: "right-arrow" },
        { text: "Demo runbook", link: "/demo/runbook/", variant: "minimal" },
      ],
    },
  },
  body: landingBody(readme.body.replace(/^>.*\n+/m, "")),
});

await rm(outRoot, { recursive: true, force: true });
let diagrams = 0;
for (const page of pages) {
  page.body = transformBody(page.body, (text) => rewriteLinks(text, page.source));
  diagrams += page.body.split('<pre class="mermaid').length - 1;
  const file = join(outRoot, page.output);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, toMarkdown(page));
}
process.stdout.write(`sync-docs: wrote ${pages.length} pages with ${diagrams} Mermaid diagrams.\n`);
