import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// Static docs site for docs.rhumbatron.com, served by an assets-only Worker (envs/prod/docs.tf).
// Pages are generated from the repository docs/ folder by scripts/sync-docs.ts.
export default defineConfig({
  site: "https://docs.rhumbatron.com",
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
        { label: "Plans", items: [{ autogenerate: { directory: "plans" } }] },
        { label: "Protocols", items: [{ autogenerate: { directory: "protocols" } }] },
        { label: "Build status", link: "/build-status/" },
      ],
    }),
  ],
});
