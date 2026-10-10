/**
 * Renders <pre class="mermaid"> blocks produced by scripts/sync-docs.ts. The mermaid package is
 * imported only on pages that have a diagram, and diagrams re-render when the theme changes.
 */
const selector = "pre.mermaid";

function currentTheme(): "dark" | "default" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "default";
}

export async function renderMermaid(): Promise<void> {
  const nodes = [...document.querySelectorAll<HTMLElement>(selector)];
  if (nodes.length === 0) return;
  for (const node of nodes) node.dataset.source ??= node.textContent ?? "";

  const { default: mermaid } = await import("mermaid");
  let theme: ReturnType<typeof currentTheme> | undefined;
  const render = async () => {
    if (theme === currentTheme()) return;
    theme = currentTheme();
    mermaid.initialize({ startOnLoad: false, theme, securityLevel: "strict" });
    for (const node of nodes) {
      node.removeAttribute("data-processed");
      node.textContent = node.dataset.source ?? "";
    }
    await mermaid.run({ nodes, suppressErrors: true });
  };

  await render();
  new MutationObserver(() => void render()).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}
