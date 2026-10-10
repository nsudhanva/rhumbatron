// Pure helpers for scripts/check-binding-drift.ts: read binding names out of a wrangler.jsonc and
// out of a Terraform bindings list. Text parsing only; no dependencies.

/** Strips // and block comments (outside strings) and trailing commas from JSONC text. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function parseJsonc(text: string): Record<string, unknown> {
  return JSON.parse(stripJsonc(text)) as Record<string, unknown>;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Binding names declared at the top level of a wrangler config (env.* sections are ignored).
 * Generic on purpose: any object or array entry with a string `binding` field counts, so a new
 * wrangler binding kind is covered without a code change. Special shapes are handled by hand.
 */
export function wranglerBindingNames(config: Json): string[] {
  const names = new Set<string>();
  const skip = new Set(["env", "queues", "durable_objects", "vars", "send_email", "secrets"]);
  for (const [key, value] of Object.entries(config)) {
    if (skip.has(key)) continue;
    const entries = Array.isArray(value) ? value : [value];
    for (const e of entries) {
      if (isObj(e) && typeof e.binding === "string") names.add(e.binding);
    }
  }
  if (isObj(config.vars)) for (const k of Object.keys(config.vars)) names.add(k);
  if (isObj(config.durable_objects) && Array.isArray(config.durable_objects.bindings)) {
    for (const b of config.durable_objects.bindings)
      if (isObj(b) && typeof b.name === "string") names.add(b.name);
  }
  if (isObj(config.queues) && Array.isArray(config.queues.producers)) {
    for (const p of config.queues.producers)
      if (isObj(p) && typeof p.binding === "string") names.add(p.binding);
  }
  if (Array.isArray(config.send_email)) {
    for (const s of config.send_email)
      if (isObj(s) && typeof s.name === "string") names.add(s.name);
  }
  if (isObj(config.secrets) && Array.isArray(config.secrets.required)) {
    for (const s of config.secrets.required) if (typeof s === "string") names.add(s);
  }
  return [...names].sort();
}

/** Removes whole-line # and // comments from HCL text. */
export function stripHclComments(text: string): string {
  return text.replace(/^[ \t]*(#|\/\/).*$/gm, "");
}

/** Text from `open` (an index of ( [ or {) to its matching close, brackets inside strings ignored. */
export function balanced(text: string, open: number): string {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i] as string;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (pairs[c]) stack.push(pairs[c] as string);
    else if (stack.length > 0 && c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return text.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced brackets");
}

/** The body of `<kind> "<label>" {` (module or resource blocks), or undefined. */
export function hclBlock(text: string, kind: string, label: string): string | undefined {
  const m = new RegExp(`^${kind}\\s+"${label}"\\s*\\{`, "m").exec(text);
  if (!m) return undefined;
  return balanced(text, m.index + m[0].length - 1);
}

/** The text of the first `bindings = ...` value inside a block. */
export function hclBindingsExpr(block: string): string | undefined {
  const m = /^[ \t]*bindings\s*=\s*/m.exec(block);
  if (!m) return undefined;
  const start = m.index + m[0].length;
  const open = block.slice(start).search(/[[(]/);
  if (open === -1) return undefined;
  return balanced(block, start + open);
}

/**
 * Binding names inside a Terraform bindings expression: inline `name = "X"` entries, plus
 * `module.state.bindings.X` (the key is the name) and `local.cap_bindings.k` (resolved with capNames).
 */
export function hclBindingNames(expr: string, capNames: Record<string, string>): string[] {
  const names = new Set<string>();
  for (const m of expr.matchAll(/\bname\s*=\s*"([A-Za-z0-9_]+)"/g)) names.add(m[1] as string);
  for (const m of expr.matchAll(/module\.state\.bindings\.([A-Za-z0-9_]+)/g))
    names.add(m[1] as string);
  for (const m of expr.matchAll(/local\.cap_bindings\.([A-Za-z0-9_]+)/g)) {
    const n = capNames[m[1] as string];
    if (!n) throw new Error(`unresolved local.cap_bindings.${m[1]}`);
    names.add(n);
  }
  return [...names].sort();
}

/** Maps each `local.cap_bindings` key to its binding name. */
export function hclCapBindingNames(text: string): Record<string, string> {
  const m = /^[ \t]*cap_bindings\s*=\s*\{/m.exec(text);
  if (!m) return {};
  const body = balanced(text, m.index + m[0].length - 1);
  const out: Record<string, string> = {};
  for (const e of body.matchAll(/^\s*(\w+)\s*=\s*\{[^}]*?\bname\s*=\s*"([A-Za-z0-9_]+)"/gm)) {
    out[e[1] as string] = e[2] as string;
  }
  return out;
}
