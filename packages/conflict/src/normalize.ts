// Deterministic text normalization for the conflict detector.
// Every rule here is a documented heuristic. No model calls, no randomness, no locale-dependent APIs.
import type { ChangeKind, DataModel } from "@rhumbatron/protocol";

const PROJECT_PREFIX = /^project:[a-z0-9-]+:/;

/** Lowercases and strips `project:<slug>:`, so relative and absolute keys compare equal. */
export function normalizeResource(resource: string): string {
  return resource.trim().toLowerCase().replace(PROJECT_PREFIX, "");
}

export type Overlap = "exact" | "prefix" | "none";

/** `exact` for equal keys, `prefix` when one key is a colon-segment ancestor of the other. */
export function resourceOverlap(a: string, b: string): Overlap {
  if (a === b) return "exact";
  return a.startsWith(`${b}:`) || b.startsWith(`${a}:`) ? "prefix" : "none";
}

/** Repository-relative POSIX path without a leading `./` or `/`. */
export function normalizeFile(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "");
}

const HTTP_ROUTE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s,;)]*)/i;
const PATH_PARAM = /^(:[^/]+|\{[^}]+\}|\[[^\]]+\])$/;

type HttpRoute = { route: string; match: string };

function routeOf(m: RegExpExecArray | RegExpMatchArray): HttpRoute | null {
  if (!m[1] || !m[2]) return null;
  // Sentence punctuation after a path ("... DELETE /api/cards/:id.") is not part of the route.
  const path =
    m[2]
      .toLowerCase()
      .replace(/[.:]+$/, "")
      .replace(/\/+$/, "") || "/";
  const normalized = path
    .split("/")
    .map((segment) => (PATH_PARAM.test(segment) ? ":param" : segment))
    .join("/");
  return { route: `${m[1].toUpperCase()} ${normalized}`, match: m[0] };
}

/** Finds the first HTTP route in free text, or null. */
export function findHttpRoute(text: string): HttpRoute | null {
  const m = HTTP_ROUTE.exec(text);
  return m ? routeOf(m) : null;
}

/** Every HTTP route in free text, in order. */
export function findHttpRoutes(text: string): HttpRoute[] {
  return [...text.matchAll(new RegExp(HTTP_ROUTE.source, "gi"))]
    .map(routeOf)
    .filter((r): r is HttpRoute => r !== null);
}

/** Upper-case HTTP method names. In a contract line they name a route, never a change verb. */
const METHOD_WORD = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;

/**
 * The text without its HTTP routes and upper-case method names, so `DELETE /api/todos/:id` never
 * reads as the verb "delete". A lower-case "delete" or "remove" stays a verb.
 */
export function withoutRoutes(text: string): string {
  return text.replace(new RegExp(HTTP_ROUTE.source, "gi"), " ").replace(METHOD_WORD, " ");
}

/**
 * Contract target key. HTTP routes become `METHOD /path` with every path parameter
 * (`:id`, `{id}`, `[id]`) replaced by `:param`. Other targets keep their case; whitespace collapses.
 */
export function normalizeTarget(target: string): string {
  return findHttpRoute(target)?.route ?? target.trim().replace(/\s+/g, " ");
}

/** Shape signature: no whitespace, `;` read as `,`, trailing separators dropped. */
export function normalizeShape(shape: string): string {
  return shape
    .replace(/\s+/g, "")
    .replace(/;/g, ",")
    .replace(/,([}\])])/g, "$1");
}

/** Lowercase snake_case entity. A `table.column` reference maps to its table. */
export function normalizeEntity(entity: string): string {
  const table = entity.trim().toLowerCase().split(".")[0] ?? "";
  return table.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

const NEGATIONS = new Set([
  "not",
  "no",
  "never",
  "without",
  "cannot",
  "cant",
  "isnt",
  "arent",
  "doesnt",
  "dont",
  "wont",
  "shouldnt",
  "mustnt",
  "nor",
  "avoid",
  "avoids",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length > 0);
}

/**
 * Storage-model keywords. A match counts only when none of the three words before it is a
 * negation ("no in-place updates" does not mean mutable). Append-only patterns are checked
 * with word boundaries, so "immutable" never matches "mutable".
 */
const MODEL_PATTERNS: readonly (readonly [Exclude<DataModel, "unspecified">, RegExp])[] = [
  [
    "append_only",
    /\b(append[- ]only|insert[- ]only|event[- ]sourc(ed|ing)|event log|immutable|ledger)\b/g,
  ],
  [
    "mutable_table",
    /\b(mutable|updated? in[- ]place|in[- ]place updates?|normali[sz]ed|upserts?|join table|relational)\b/g,
  ],
  ["key_value", /\b(kv|key[- ]value)\b/g],
  ["document", /\b(json (document|blob)|document store)\b/g],
];

function negatedBefore(text: string, index: number): boolean {
  return words(text.slice(0, index))
    .slice(-3)
    .some((w) => NEGATIONS.has(w));
}

/** The single storage model the text names, or `unspecified` when it names none or several. */
export function modelFromText(text: string): DataModel {
  const lower = text.toLowerCase();
  const found = new Set<DataModel>();
  for (const [model, pattern] of MODEL_PATTERNS) {
    for (const match of lower.matchAll(pattern)) {
      if (!negatedBefore(lower, match.index)) found.add(model);
    }
  }
  const [only] = found;
  return found.size === 1 && only !== undefined ? only : "unspecified";
}

/** `append_only` versus any in-place model is a different concurrency semantics for one resource. */
export function incompatibleModels(a: DataModel, b: DataModel): boolean {
  if (a === "unspecified" || b === "unspecified") return false;
  return (a === "append_only") !== (b === "append_only");
}

const KIND_PATTERNS: readonly (readonly [ChangeKind, RegExp])[] = [
  ["remove", /\b(remove[sd]?|delete[sd]?|drop(s|ped)?|deprecate[sd]?)\b/],
  [
    "modify",
    /\b(change[sd]?|modif(y|ies|ied)|rename[sd]?|update[sd]?|replace[sd]?|alter(s|ed)?|extend(s|ed)?|migrate[sd]?)\b/,
  ],
  ["add", /\b(add(s|ed)?|new|create[sd]?|introduce[sd]?)\b/],
];

/** The kind of the earliest change verb in the text, or null when it names none. */
function explicitKind(text: string): ChangeKind | null {
  const lower = text.toLowerCase();
  let best: { kind: ChangeKind; index: number } | null = null;
  for (const [kind, pattern] of KIND_PATTERNS) {
    const m = pattern.exec(lower);
    if (m && (best === null || m.index < best.index)) best = { kind, index: m.index };
  }
  return best?.kind ?? null;
}

/**
 * The earliest change verb in the text decides the kind ("Add endpoint to remove items" is `add`).
 * No verb means `modify`: the safe side, because only additive changes can be dismissed.
 */
export function kindFromText(text: string): ChangeKind {
  return explicitKind(text) ?? "modify";
}

/** "None", "No change", "No contract changes", "N/A" at the start of a declaration line. */
const NO_CHANGE = /^\s*(none|n\/?a|no(ne)?\b[^.;:]*\bchanges?)\b[\s.;:,-]*/i;
/** Verbs of a Task that only uses a contract another Task owns. */
const CONSUMES =
  /\b(uses?|using|consumes?|consuming|calls?|calling|reads?|reading|fetch(es|ing)?|depends? on|relies on|relying on|talks? to|against)\b/i;

/**
 * True when a contract line declares no change of its own: it says "None" or "No change", or it
 * only uses, consumes, or calls routes ("None. The UI consumes GET /api/todos and DELETE
 * /api/todos/:id."). Routes and method names never count as verbs here, and neither does "new"
 * ("calls the new GET /api/todos").
 */
export function declaresNoChange(text: string): boolean {
  const noChange = NO_CHANGE.exec(text);
  const rest = withoutRoutes(noChange ? text.slice(noChange[0].length) : text).replace(
    /\bnew\b/gi,
    " ",
  );
  if (explicitKind(rest) !== null) return false;
  return noChange !== null || CONSUMES.test(rest);
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "be",
  "been",
  "was",
  "were",
  "to",
  "of",
  "for",
  "in",
  "on",
  "at",
  "by",
  "and",
  "or",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "must",
  "should",
  "will",
  "can",
  "may",
  "we",
  "each",
  "any",
  "all",
  "with",
  "as",
  "from",
  "do",
  "does",
]);

/** Antonyms map to their positive form plus one polarity flip. */
const ANTONYMS: Readonly<Record<string, string>> = {
  immutable: "mutable",
  "append-only": "mutable",
  "read-only": "writable",
  readonly: "writable",
  optional: "required",
  private: "public",
  asynchronous: "synchronous",
  async: "sync",
  forbidden: "allowed",
  disallowed: "allowed",
  denied: "allowed",
  unauthenticated: "authenticated",
  anonymous: "authenticated",
  stateless: "stateful",
};

function stem(word: string): string {
  return word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

type Proposition = { core: Set<string>; negative: boolean };

function proposition(text: string): Proposition {
  const core = new Set<string>();
  let flips = 0;
  for (const raw of words(text)) {
    if (NEGATIONS.has(raw)) {
      flips += 1;
      continue;
    }
    const antonym = ANTONYMS[raw];
    if (antonym !== undefined) {
      flips += 1;
      core.add(antonym);
      continue;
    }
    if (!STOPWORDS.has(raw)) core.add(stem(raw));
  }
  return { core, negative: flips % 2 === 1 };
}

/** Minimum Jaccard similarity of two assumption cores to compare their polarity. */
const ASSUMPTION_SIMILARITY = 0.75;

/**
 * Keyword-negation heuristic. Each assumption becomes a set of content words (stopwords removed,
 * plural `s` stripped) and a polarity (negations and antonyms each flip it). Two assumptions
 * contradict when both cores have at least two words, their Jaccard similarity is at least
 * `ASSUMPTION_SIMILARITY`, and their polarities differ.
 */
export function assumptionsContradict(a: string, b: string): boolean {
  const pa = proposition(a);
  const pb = proposition(b);
  if (pa.core.size < 2 || pb.core.size < 2 || pa.negative === pb.negative) return false;
  let shared = 0;
  for (const w of pa.core) if (pb.core.has(w)) shared += 1;
  const union = pa.core.size + pb.core.size - shared;
  return shared / union >= ASSUMPTION_SIMILARITY;
}
