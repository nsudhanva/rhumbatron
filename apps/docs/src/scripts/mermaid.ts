/**
 * Renders <pre class="mermaid"> blocks produced by scripts/sync-docs.ts. Each diagram renders
 * only when it comes near the viewport, so the mermaid package never loads or runs during the
 * first paint. Rendered diagrams re-render when the theme changes.
 */
type Theme = "dark" | "default";
type Mermaid = typeof import("mermaid")["default"];

const selector = "pre.mermaid";

/**
 * Overrides for the stock mermaid themes so that every label meets WCAG AA (4.5:1) on its fill.
 * The stock dark theme sets edge labels (#ccc) on #585858 (4.4:1) and note text (#b8b5b5) on
 * #474a4a (4.4:1). The stock default theme passes.
 */
const themeVariables: Record<Theme, Record<string, string>> = {
  default: {},
  dark: { edgeLabelBackground: "#4d4d4d", noteTextColor: "#cccccc" },
};

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "default";
}

/** Yields to the browser so that one diagram is one task, not one long task for the page. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function renderMermaid(): void {
  const nodes = [...document.querySelectorAll<HTMLElement>(selector)];
  if (nodes.length === 0) return;
  for (const node of nodes) node.dataset.source ??= node.textContent ?? "";

  let mermaid: Promise<Mermaid> | undefined;
  let configured: Theme | undefined;
  let queue = Promise.resolve();
  const rendered = new Map<HTMLElement, Theme>();

  const render = async (targets: HTMLElement[]) => {
    mermaid ??= import("mermaid").then((m) => m.default);
    const api = await mermaid;
    for (const node of targets) {
      const theme = currentTheme();
      if (rendered.get(node) === theme) continue;
      if (configured !== theme) {
        api.initialize({
          startOnLoad: false,
          theme,
          themeVariables: themeVariables[theme],
          securityLevel: "strict",
        });
        configured = theme;
      }
      node.removeAttribute("data-processed");
      node.textContent = node.dataset.source ?? "";
      await api.run({ nodes: [node], suppressErrors: true });
      rendered.set(node, theme);
      await nextTask();
    }
  };
  const schedule = (targets: HTMLElement[]) => {
    queue = queue.then(() => render(targets)).catch(() => undefined);
  };

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((e) => e.isIntersecting).map((e) => e.target as HTMLElement);
      for (const node of visible) observer.unobserve(node);
      if (visible.length > 0) schedule(visible);
    },
    { rootMargin: "200px 0px" },
  );
  for (const node of nodes) observer.observe(node);

  new MutationObserver(() => schedule([...rendered.keys()])).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}
