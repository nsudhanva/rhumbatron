import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// Static docs site. The edge (Caddy) serves the build at docs.rhumbatron.localhost, and
// `bun run docs:deploy` publishes it to Cloudflare Pages at rhumbatron.com (DOCS_SITE).
// Pages are generated from the repository docs/ folder by scripts/sync-docs.ts.
export default defineConfig({
  site: process.env.DOCS_SITE ?? "https://docs.rhumbatron.localhost",
  integrations: [
    starlight({
      title: "Rhumbatron",
      description: "Git, CI, and a distributed task scheduler for autonomous software developers.",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/custom.css"],
      components: {
        MarkdownContent: "./src/components/MarkdownContent.astro",
      },
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/nsudhanva/rhumbatron" },
      ],
      lastUpdated: false,
      sidebar: [
        { label: "Overview", link: "/" },
        { label: "Architecture", items: [{ autogenerate: { directory: "architecture" } }] },
        { label: "Operations", items: [{ autogenerate: { directory: "operations" } }] },
        { label: "Demo", items: [{ autogenerate: { directory: "demo" } }] },
        { label: "Decisions", collapsed: true, items: [{ autogenerate: { directory: "adr" } }] },
        { label: "Protocols", items: [{ autogenerate: { directory: "protocols" } }] },
        { label: "Build status", link: "/build-status/" },
      ],
    }),
  ],
});
