import { parse } from "@babel/parser";
import type { DeclarationKind, FileSymbols } from "@rhumbatron/context-compiler";

/**
 * Exact symbol extraction for TypeScript and JavaScript. Top-level statements only:
 * imports, re-exports, exports, and declarations. @babel/parser is pure JavaScript (no WASM, about
 * 480 KB), parses a 200-line file in about a millisecond, and keeps going after syntax errors.
 * The TypeScript compiler API would add several megabytes for the same facts.
 */

/** Files larger than this are listed but not parsed. */
export const MAX_PARSE_BYTES = 200_000;

const TS = /\.(ts|tsx|mts|cts)$/;
const JS = /\.(js|jsx|mjs|cjs)$/;

/** Never read, parse, or embed: environment files, keys, and credential stores. */
const SENSITIVE =
  /(^|\/)(\.env(\..*)?|\.dev\.vars(\..*)?|\.npmrc|id_(rsa|ed25519|ecdsa)[^/]*|credentials[^/]*|secrets?(\.[^/]*)?|[^/]*\.(pem|key|p12|pfx|jks|keystore))$/i;

const isSensitivePath = (path: string) => SENSITIVE.test(path);

function languageOf(path: string): FileSymbols["lang"] {
  if (path.endsWith(".d.ts")) return "ts";
  if (TS.test(path)) return "ts";
  if (JS.test(path)) return "js";
  return "other";
}

/** True when the indexer must read the blob: parseable code that is not sensitive. */
export const needsContent = (path: string) =>
  languageOf(path) !== "other" && !isSensitivePath(path);

type Node = { type: string; [key: string]: unknown };
type Comment = { type: string; value: string };

const nameOf = (node: unknown): string | null => {
  const n = node as { type?: string; name?: unknown; value?: unknown } | null;
  if (n?.type === "Identifier" && typeof n.name === "string") return n.name;
  if (n?.type === "StringLiteral" && typeof n.value === "string") return n.value;
  return null;
};

/** Identifiers bound by a variable declarator pattern (`const { a, b: [c] } = x`). */
function patternNames(pattern: unknown, out: string[] = []): string[] {
  const p = pattern as Node | null;
  if (!p) return out;
  switch (p.type) {
    case "Identifier":
      out.push(String(p.name));
      break;
    case "ObjectPattern":
      for (const prop of (p.properties as Node[]) ?? []) {
        patternNames(prop.type === "RestElement" ? prop.argument : prop.value, out);
      }
      break;
    case "ArrayPattern":
      for (const el of (p.elements as Node[]) ?? []) patternNames(el, out);
      break;
    case "RestElement":
      patternNames(p.argument, out);
      break;
    case "AssignmentPattern":
      patternNames(p.left, out);
      break;
  }
  return out;
}

function declared(node: Node): { name: string; kind: DeclarationKind }[] {
  switch (node.type) {
    case "FunctionDeclaration":
    case "TSDeclareFunction": {
      const name = nameOf(node.id);
      return name ? [{ name, kind: "function" }] : [];
    }
    case "ClassDeclaration": {
      const name = nameOf(node.id);
      return name ? [{ name, kind: "class" }] : [];
    }
    case "VariableDeclaration": {
      const kind = node.kind === "let" || node.kind === "var" ? node.kind : "const";
      return ((node.declarations as Node[]) ?? []).flatMap((d) =>
        patternNames(d.id).map((name) => ({ name, kind: kind as DeclarationKind })),
      );
    }
    case "TSTypeAliasDeclaration": {
      const name = nameOf(node.id);
      return name ? [{ name, kind: "type" }] : [];
    }
    case "TSInterfaceDeclaration": {
      const name = nameOf(node.id);
      return name ? [{ name, kind: "interface" }] : [];
    }
    case "TSEnumDeclaration": {
      const name = nameOf(node.id);
      return name ? [{ name, kind: "enum" }] : [];
    }
    default:
      return [];
  }
}

const lineOf = (node: Node) =>
  (node.loc as { start?: { line?: number } } | undefined)?.start?.line ?? 0;

/** First meaningful line of a comment: JSDoc stars, slashes, and tags removed. */
function firstLine(comment: Comment | undefined): string | null {
  if (!comment) return null;
  for (const raw of comment.value.split("\n")) {
    const line = raw.replace(/^\s*\*+\s?/, "").trim();
    if (line && !line.startsWith("@") && !/^[-=*/]+$/.test(line)) return line.slice(0, 200);
  }
  return null;
}

export type ParseInput = { path: string; blob: string; content: string | null };

/** Symbols of one file. Never throws: a file that cannot be parsed is marked, not dropped. */
export function extractSymbols({ path, blob, content }: ParseInput): FileSymbols {
  const lang = languageOf(path);
  const empty: FileSymbols = {
    path,
    blob,
    lang,
    exports: [],
    declarations: [],
    imports: [],
    doc: null,
  };
  if (isSensitivePath(path)) return { ...empty, skipped: "sensitive" };
  if (lang === "other") return { ...empty, skipped: "not_code" };
  if (content === null || content.length > MAX_PARSE_BYTES)
    return { ...empty, skipped: "too_large" };

  let program: { body: Node[] };
  try {
    const jsx = /x$/.test(path) || lang === "js";
    const ast = parse(content, {
      sourceType: "module",
      errorRecovery: true,
      plugins: lang === "ts" ? (jsx ? ["typescript", "jsx"] : ["typescript"]) : ["jsx"],
    }) as unknown as { program: { body: Node[] } };
    program = ast.program;
  } catch {
    return { ...empty, skipped: "parse_error" };
  }

  const exports = new Set<string>();
  const declarations: FileSymbols["declarations"] = [];
  const imports: FileSymbols["imports"] = [];
  const addDecls = (node: Node, exported: boolean) => {
    for (const d of declared(node)) {
      declarations.push({ ...d, exported, line: lineOf(node) });
      if (exported) exports.add(d.name);
    }
  };

  for (const node of program.body) {
    switch (node.type) {
      case "ImportDeclaration": {
        const source = (node.source as { value: string }).value;
        const typeOnly = node.importKind === "type";
        const names = ((node.specifiers as Node[]) ?? []).map((s) =>
          s.type === "ImportDefaultSpecifier"
            ? "default"
            : s.type === "ImportNamespaceSpecifier"
              ? "*"
              : (nameOf(s.imported) ?? "?"),
        );
        imports.push({ source, names, typeOnly, resolved: null });
        break;
      }
      case "ExportNamedDeclaration": {
        if (node.declaration) addDecls(node.declaration as Node, true);
        const specifiers = (node.specifiers as Node[]) ?? [];
        for (const s of specifiers) {
          const exported = nameOf(s.exported);
          if (exported) exports.add(exported);
        }
        if (node.source) {
          imports.push({
            source: (node.source as { value: string }).value,
            names: specifiers.map((s) => nameOf(s.local) ?? "?"),
            typeOnly: node.exportKind === "type",
            resolved: null,
          });
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        exports.add("default");
        const decl = node.declaration as Node;
        if (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") {
          addDecls(decl, true);
        }
        break;
      }
      case "ExportAllDeclaration": {
        const exported = nameOf(node.exported);
        exports.add(exported ?? "*");
        imports.push({
          source: (node.source as { value: string }).value,
          names: ["*"],
          typeOnly: node.exportKind === "type",
          resolved: null,
        });
        break;
      }
      default:
        addDecls(node, false);
    }
  }

  // `export { name }` after the declaration.
  for (const d of declarations) if (exports.has(d.name)) d.exported = true;

  const first = program.body[0] as (Node & { leadingComments?: Comment[] }) | undefined;
  return {
    ...empty,
    exports: [...exports].sort(),
    declarations,
    imports,
    doc: firstLine(first?.leadingComments?.[0]),
  };
}
