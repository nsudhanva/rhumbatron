/**
 * CodeMirror 6 setup for the code editor. `code-editor.tsx` imports this module dynamically on
 * the client, so CodeMirror is a separate chunk and the server render never loads it.
 * The theme reads the app's CSS variables (theme.css), so one theme serves light and dark mode
 * and matches the mono file view (TOKEN_CLASS in highlight.ts).
 */
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";

export type EditorOptions = {
  value: string;
  path: string;
  readOnly: boolean;
  label: string;
  minHeight?: number | undefined;
  maxHeight?: number | undefined;
  onChange: (value: string) => void;
};

/**
 * Loads the language support for the file extension; other files are plain text. Each language
 * is its own chunk, so an editor loads only the parser it shows.
 */
async function languageFor(path: string): Promise<Extension> {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
    case "tsx":
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
    case "jsonc": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ typescript: /^[mc]?tsx?$/.test(ext), jsx: ext.endsWith("x") });
    }
    case "json": {
      const { json } = await import("@codemirror/lang-json");
      return json();
    }
    case "css": {
      const { css } = await import("@codemirror/lang-css");
      return css();
    }
    case "html":
    case "htm": {
      const { html } = await import("@codemirror/lang-html");
      return html();
    }
    case "md":
    case "markdown": {
      const { markdown } = await import("@codemirror/lang-markdown");
      return markdown();
    }
    default:
      return [];
  }
}

type Highlighter = Parameters<typeof syntaxHighlighting>[0];

/**
 * Highlight roles by tag name, the same roles as TOKEN_CLASS in highlight.ts. Each tag's `set`
 * lists the tag and its parents from most to least specific, so `lineComment` finds `comment`
 * and `null` finds `keyword`. The classes are styled in `theme()`.
 */
const ROLE_BY_TAG: Record<string, string> = {
  comment: "cm-rh-comment",
  string: "cm-rh-string",
  regexp: "cm-rh-string",
  number: "cm-rh-number",
  bool: "cm-rh-keyword",
  keyword: "cm-rh-keyword",
  heading: "cm-rh-strong",
  strong: "cm-rh-strong",
  emphasis: "cm-rh-emphasis",
  link: "cm-rh-link",
  url: "cm-rh-link",
  invalid: "cm-rh-invalid",
};

const highlighter: Highlighter = {
  style(tags) {
    const classes = new Set<string>();
    for (const tag of tags) {
      for (const parent of tag.set) {
        const role = ROLE_BY_TAG[parent.toString()];
        if (role) {
          classes.add(role);
          break;
        }
      }
    }
    return classes.size > 0 ? [...classes].join(" ") : null;
  },
};

function theme(minHeight?: number, maxHeight?: number): Extension {
  return EditorView.theme({
    "&": {
      color: "var(--text-color-kumo-default)",
      backgroundColor: "transparent",
      fontSize: "12px",
      ...(maxHeight ? { maxHeight: `${maxHeight}px` } : {}),
    },
    "&.cm-focused": {
      outline: "2px solid var(--color-accent-500)",
      outlineOffset: "-2px",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      lineHeight: "1.7",
      overflow: "auto",
    },
    ".cm-content": {
      padding: "8px 0",
      caretColor: "var(--color-accent-500)",
      ...(minHeight ? { minHeight: `${minHeight}px` } : {}),
    },
    ".cm-line": { padding: "0 12px" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent-500)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "color-mix(in srgb, var(--color-accent-500) 30%, transparent)" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "var(--text-color-kumo-subtle)",
      border: "none",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "40px",
      padding: "0",
      textAlign: "right",
    },
    ".cm-activeLine": { backgroundColor: "var(--color-kumo-row-hover)" },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "var(--text-color-kumo-default)",
    },
    "&.cm-focused .cm-matchingBracket": {
      backgroundColor: "var(--color-accent-wash-strong)",
      outline: "none",
    },
    "&.cm-focused .cm-nonmatchingBracket": { color: "var(--text-color-kumo-danger)" },
    ".cm-selectionMatch": { backgroundColor: "var(--color-accent-wash)" },
    ".cm-searchMatch": {
      backgroundColor: "var(--color-kumo-warning-tint)",
      outline: "1px solid var(--color-kumo-warning)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "var(--color-accent-wash-strong)",
    },
    ".cm-panels": {
      backgroundColor: "var(--color-kumo-elevated)",
      color: "var(--text-color-kumo-default)",
    },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--color-kumo-rule)" },
    ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--color-kumo-rule)" },
    ".cm-panel.cm-search": { padding: "6px 12px", fontFamily: "var(--font-mono)" },
    ".cm-panel.cm-search input, .cm-panel.cm-search button": {
      fontFamily: "inherit",
      fontSize: "12px",
    },
    ".cm-textfield": {
      backgroundColor: "var(--color-kumo-base)",
      border: "1px solid var(--color-kumo-line)",
      borderRadius: "0",
      color: "inherit",
    },
    ".cm-button": {
      backgroundImage: "none",
      backgroundColor: "var(--color-kumo-fill)",
      border: "1px solid var(--color-kumo-line)",
      borderRadius: "0",
      color: "inherit",
    },
    ".cm-button:hover": { backgroundColor: "var(--color-kumo-fill-hover)" },
    ".cm-rh-comment": { color: "var(--text-color-kumo-subtle)", fontStyle: "italic" },
    ".cm-rh-string": { color: "var(--text-color-kumo-success)" },
    ".cm-rh-number": { color: "var(--text-color-kumo-warning)" },
    ".cm-rh-keyword, .cm-rh-strong": { fontWeight: "600" },
    ".cm-rh-emphasis": { fontStyle: "italic" },
    ".cm-rh-link": { color: "var(--text-color-kumo-link)" },
    ".cm-rh-invalid": { color: "var(--text-color-kumo-danger)" },
  });
}

/** Mounts one editor into `parent`. Tab indents; Escape then Tab moves focus out (built in). */
export async function createEditor(
  parent: HTMLElement,
  options: EditorOptions,
): Promise<EditorView> {
  const language = await languageFor(options.path);
  const extensions: Extension[] = [
    // Line numbers pad like the file view: at least two digits, zero-filled.
    lineNumbers({
      formatNumber: (n, state) =>
        String(n).padStart(Math.max(2, String(state.doc.lines).length), "0"),
    }),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    history(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    search({ top: true }),
    highlightSelectionMatches(),
    syntaxHighlighting(highlighter),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    language,
    theme(options.minHeight, options.maxHeight),
    EditorView.contentAttributes.of({ "aria-label": options.label }),
    EditorState.readOnly.of(options.readOnly),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onChange(update.state.doc.toString());
    }),
  ];
  return new EditorView({
    parent,
    state: EditorState.create({ doc: options.value, extensions }),
  });
}

/** Replaces the whole document when the outside value differs from it (line ends normalized). */
export function syncValue(view: EditorView, value: string): void {
  const next = value.replace(/\r\n?/g, "\n");
  const current = view.state.doc.toString();
  if (next === current) return;
  view.dispatch({ changes: { from: 0, to: current.length, insert: next } });
}
