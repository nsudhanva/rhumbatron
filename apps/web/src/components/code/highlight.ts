/**
 * Small syntax highlighter for the code view: comments, strings, numbers and keywords
 * for the languages template Projects use. No dependency; anything it does not know is plain.
 * Tokens are produced for the whole text, so block comments and template strings span lines.
 */

export type TokenKind = "plain" | "comment" | "string" | "keyword" | "number";
export type Token = { text: string; kind: TokenKind };

type Lang = {
  line?: string[];
  block?: [string, string];
  quotes: string[];
  keywords: ReadonlySet<string>;
};

const JS_KEYWORDS = new Set(
  (
    "abstract as async await break case catch class const continue debugger declare default " +
    "delete do else enum export extends false finally for from function get if implements import " +
    "in instanceof interface is keyof let new null of private protected public readonly return " +
    "satisfies set static super switch this throw true try type typeof undefined using var void " +
    "while with yield"
  ).split(" "),
);
const SQL_KEYWORDS = new Set(
  (
    "add all alter and as asc by check create default delete desc distinct drop exists foreign " +
    "from group having in index insert integer into is join key left not null on or order " +
    "primary references select set table text unique update values where"
  ).split(" "),
);
const NONE: ReadonlySet<string> = new Set();

const LANGS: Record<string, Lang> = {
  js: { line: ["//"], block: ["/*", "*/"], quotes: ['"', "'", "`"], keywords: JS_KEYWORDS },
  json: { quotes: ['"'], keywords: new Set(["true", "false", "null"]) },
  css: { block: ["/*", "*/"], quotes: ['"', "'"], keywords: NONE },
  hash: { line: ["#"], quotes: ['"', "'"], keywords: new Set(["true", "false", "null"]) },
  sql: { line: ["--"], block: ["/*", "*/"], quotes: ["'"], keywords: SQL_KEYWORDS },
};

const BY_EXTENSION: Record<string, keyof typeof LANGS> = {
  ts: "js",
  tsx: "js",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  mts: "js",
  cts: "js",
  json: "json",
  jsonc: "js",
  css: "css",
  sh: "hash",
  bash: "hash",
  toml: "hash",
  yaml: "hash",
  yml: "hash",
  sql: "sql",
};

/** Above this size the text is shown plain: highlighting would cost more than it helps. */
const MAX_HIGHLIGHT_CHARS = 200_000;

function languageOf(path: string): Lang | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === "dockerfile" || name === ".gitignore") return LANGS.hash ?? null;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const key = BY_EXTENSION[ext];
  return key ? (LANGS[key] ?? null) : null;
}

const IDENT = /[A-Za-z_$][\w$]*/y;
const NUMBER = /(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?n?)/y;

function tokenize(text: string, lang: Lang): Token[] {
  const tokens: Token[] = [];
  const push = (t: string, kind: TokenKind) => {
    const last = tokens.at(-1);
    if (last && last.kind === kind && kind === "plain") last.text += t;
    else tokens.push({ text: t, kind });
  };
  let i = 0;
  while (i < text.length) {
    const rest = (s: string) => text.startsWith(s, i);
    if (lang.block && rest(lang.block[0])) {
      const end = text.indexOf(lang.block[1], i + lang.block[0].length);
      const stop = end === -1 ? text.length : end + lang.block[1].length;
      push(text.slice(i, stop), "comment");
      i = stop;
      continue;
    }
    const lineMark = lang.line?.find(rest);
    if (lineMark) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      push(text.slice(i, stop), "comment");
      i = stop;
      continue;
    }
    const ch = text[i] ?? "";
    if (lang.quotes.includes(ch)) {
      let j = i + 1;
      while (j < text.length) {
        const c = text[j];
        if (c === "\\") j += 2;
        else if (c === ch) {
          j += 1;
          break;
        } else if (c === "\n" && ch !== "`") break;
        else j += 1;
      }
      push(text.slice(i, j), "string");
      i = j;
      continue;
    }
    const prev = text[i - 1] ?? "";
    if (/\d/.test(ch) && !/[\w$]/.test(prev)) {
      NUMBER.lastIndex = i;
      const match = NUMBER.exec(text);
      if (match) {
        push(match[0], "number");
        i += match[0].length;
        continue;
      }
    }
    IDENT.lastIndex = i;
    const ident = /[A-Za-z_$]/.test(ch) ? IDENT.exec(text) : null;
    if (ident) {
      const word = ident[0];
      const keyword = lang.keywords.has(lang === LANGS.sql ? word.toLowerCase() : word);
      push(word, keyword && prev !== "." ? "keyword" : "plain");
      i += word.length;
      continue;
    }
    push(ch, "plain");
    i += 1;
  }
  return tokens;
}

/** Splits highlighted text into lines of tokens (one entry per source line). */
export function highlightLines(text: string, path: string): Token[][] {
  const lang = languageOf(path);
  const tokens =
    lang && text.length <= MAX_HIGHLIGHT_CHARS
      ? tokenize(text, lang)
      : [{ text, kind: "plain" as const }];
  const lines: Token[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1]?.push({ text: part, kind: token.kind });
    });
  }
  // A trailing newline ends the last line; it does not start an empty one.
  if (text.endsWith("\n") && lines.length > 1 && lines.at(-1)?.length === 0) lines.pop();
  return lines;
}

export const TOKEN_CLASS: Record<TokenKind, string | undefined> = {
  plain: undefined,
  comment: "text-kumo-subtle italic",
  string: "text-kumo-success",
  keyword: "font-semibold",
  number: "text-kumo-warning",
};
