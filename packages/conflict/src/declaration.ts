// Converts the string fields an agent declares at `complete_task` into a typed Intent.
// Deterministic parsing rules, documented per function. Ambiguity resolves to the safe side:
// an unknown change kind is `modify` (never dismissed) and an unknown storage model is `unspecified`.
import {
  type ContractChange,
  type DataChange,
  type DataModel,
  Intent,
  RelativeResource,
} from "@rhumbatron/protocol";
import {
  declaresNoChange,
  findHttpRoute,
  findHttpRoutes,
  kindFromText,
  modelFromText,
  normalizeEntity,
  normalizeResource,
  normalizeTarget,
  withoutRoutes,
} from "./normalize.ts";

/** The agent's `complete_task` arguments (workers/agents/src/task-tools.ts `IntentArgs`). */
export type DeclaredIntent = {
  summary: string;
  semanticResources: readonly string[];
  expectedFiles: readonly string[];
  expectedContractChanges: readonly string[];
  expectedDataChanges: readonly string[];
  assumptions: readonly string[];
  expectedSymbols?: readonly string[];
  expectedSideEffects?: readonly string[];
};

export type IntentMeta = { intentId: string; taskId: string; agentId: string; createdAt: string };

const BACKTICK = /`([^`]+)`/;
const EVENT_TYPE = /\b[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\b/;
const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?:\.[a-z0-9_]+)?\b/;
const TABLE_AFTER = /\b(?:table|collection|column|entity)\s+([a-z0-9_.]+)/;
const TABLE_BEFORE = /\b([a-z0-9_]+)\s+(?:table|collection)\b/;
const NOT_ENTITY = new Set(["a", "an", "the", "new", "one", "join", "mutable", "normalized"]);

/** First balanced `{...}` group in the text, or undefined. */
function firstBraceGroup(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

const clip = (text: string, max: number) => text.trim().slice(0, max);

/**
 * Null when the line declares no change of its own (`declaresNoChange`: "None", or a Task that
 * only uses or calls routes); `consumedRoutes` keeps those routes. Otherwise: Target: the first
 * HTTP route (`POST /v1/wishlists/:id`), else the first backticked token, else the first dotted
 * event type (`wishlist.shared`), else the whole text. Kind: the earliest change verb outside the
 * routes, default `modify`; HTTP method names are never verbs, so `DELETE /api/todos/:id -> {ok}`
 * is a `modify` of that route and only wording like "Removes DELETE /api/todos/:id" is `remove`.
 * Shape: the first balanced `{...}` group outside the route, if any.
 */
export function parseContractChange(text: string): ContractChange | null {
  if (declaresNoChange(text)) return null;
  const route = findHttpRoute(text);
  const rest = route ? text.replace(route.match, " ") : text;
  const target =
    route?.route ??
    BACKTICK.exec(text)?.[1] ??
    EVENT_TYPE.exec(text)?.[0] ??
    normalizeTarget(text.toLowerCase());
  const shape = firstBraceGroup(rest.replace(BACKTICK, " "));
  return {
    target: clip(target, 300) || "unknown",
    kind: kindFromText(withoutRoutes(text)),
    ...(shape === undefined ? {} : { shape: clip(shape, 2000) }),
    description: clip(text, 2000),
  };
}

/** Normalized routes of the contract lines that declare no change: what the Task uses. */
function consumedRoutes(lines: readonly string[]): string[] {
  return [
    ...new Set(
      lines.filter(declaresNoChange).flatMap((line) => findHttpRoutes(line).map((r) => r.route)),
    ),
  ].slice(0, 20);
}

/**
 * Entity: the first backticked token, else the first snake_case token, else the word after
 * `table|collection|column|entity`, else the word before `table|collection`, else the whole text.
 * `table.column` maps to the table. Model: keywords in this text, else `fallbackModel`.
 */
export function parseDataChange(
  text: string,
  fallbackModel: DataModel = "unspecified",
): DataChange {
  const lower = text.toLowerCase();
  const before = TABLE_BEFORE.exec(lower)?.[1];
  const raw =
    BACKTICK.exec(lower)?.[1] ??
    SNAKE.exec(lower)?.[0] ??
    TABLE_AFTER.exec(lower)?.[1] ??
    (before !== undefined && !NOT_ENTITY.has(before) ? before : undefined) ??
    lower;
  const model = modelFromText(text);
  return {
    entity: clip(normalizeEntity(raw), 200) || "unknown",
    kind: kindFromText(text),
    model: model === "unspecified" ? fallbackModel : model,
    description: clip(text, 2000),
  };
}

/**
 * Builds a validated Intent from an agent declaration. Resources are normalized to plan-relative
 * keys and invalid keys are dropped. When a data change names no storage model, the model named
 * by the summary and assumptions (if exactly one) applies. Contract lines that declare no change
 * are not contract changes; their routes become `consumedContracts`. Throws when the result is
 * invalid.
 */
export function intentFromDeclaration(declared: DeclaredIntent, meta: IntentMeta): Intent {
  const intentModel = modelFromText([declared.summary, ...declared.assumptions].join(". "));
  const consumed = consumedRoutes(declared.expectedContractChanges.slice(0, 20));
  const resources = [
    ...new Set(
      declared.semanticResources
        .map(normalizeResource)
        .filter((r) => RelativeResource.safeParse(r).success),
    ),
  ];
  return Intent.parse({
    ...meta,
    summary: clip(declared.summary, 2000),
    semanticResources: resources.slice(0, 10),
    expectedFiles: declared.expectedFiles
      .map((f) => clip(f, 300))
      .filter(Boolean)
      .slice(0, 50),
    expectedSymbols: (declared.expectedSymbols ?? [])
      .map((s) => clip(s, 300))
      .filter(Boolean)
      .slice(0, 50),
    expectedContractChanges: declared.expectedContractChanges
      .slice(0, 20)
      .map(parseContractChange)
      .filter((c): c is ContractChange => c !== null),
    expectedDataChanges: declared.expectedDataChanges
      .slice(0, 20)
      .map((d) => parseDataChange(d, intentModel)),
    expectedSideEffects: (declared.expectedSideEffects ?? []).slice(0, 20).map((s) => clip(s, 500)),
    assumptions: declared.assumptions.slice(0, 20).map((a) => clip(a, 500)),
    ...(consumed.length > 0 ? { consumedContracts: consumed } : {}),
  });
}
