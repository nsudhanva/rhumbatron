import type { ChangeSetIntent } from "@rhumbatron/protocol";

/**
 * Deterministic ChangeSet compatibility (AGENTS.md section 33). Runs before a Candidate is composed.
 * A rejection here is cheap; a missed conflict is still caught by verification, so the rules only
 * reject what they can prove from declared Intent fields and changed files.
 */

export type ComposableChangeSet = {
  id: string;
  baseGeneration: number;
  /** ChangeSet IDs this one needs in the same composition. */
  dependsOn?: readonly string[];
  intent: Pick<ChangeSetIntent, "expectedContractChanges" | "expectedDataChanges"> & {
    changeSet?: { files: readonly string[] } | undefined;
  };
};

export type CompatibilityKind =
  | "base_mismatch"
  | "contract_conflict"
  | "invariant_violation"
  | "unsatisfied_dependency"
  | "migration_order"
  | "file_conflict";

export type CompatibilityResult =
  | { ok: true }
  | { ok: false; kind: CompatibilityKind; detail: string };

export type CompatibilityOptions = {
  /** Policy `protectedResources` (section 53), for example `cart` or `identity.auth`. */
  protectedResources?: readonly string[];
  /**
   * Contract keys (from `contractKey`) whose overlap conflict review already dismissed as benign,
   * for example two additive columns on one table (section 32.3). Each dismissal has a receipt.
   */
  dismissedContractKeys?: readonly string[];
};

const HTTP_ROUTE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i;

/** Words that describe the kind of change, not the contract it applies to. */
const STOPWORDS = new Set(
  (
    "a add alter an api change changes column columns create drop endpoint event field fields for " +
    "in index modify new of on remove rename route schema table tables the to type update with"
  ).split(" "),
);

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Route path segments without `api`, version, or parameter segments. */
function routeSegments(path: string): string[] {
  return path
    .toLowerCase()
    .split("/")
    .filter(
      (s) => s && !s.startsWith(":") && !s.startsWith("{") && s !== "api" && !/^v[0-9]+$/.test(s),
    );
}

/** What a declared change applies to, as tokens: route segments, or the head without change verbs. */
function subject(change: string): { route?: string; tokens: string[] } {
  const route = HTTP_ROUTE.exec(change.trim());
  if (route?.[1] && route[2]) {
    const segments = routeSegments(route[2]);
    return {
      route: `${route[1].toUpperCase()} /${segments.join("/")}`,
      tokens: segments.flatMap(tokens),
    };
  }
  const head = change.split(/:|\s-\s|\(/)[0] ?? change;
  return { tokens: tokens(head).filter((t) => !STOPWORDS.has(t)) };
}

/**
 * The contract a declared change applies to. `POST /api/wishlists/:id - add item` and
 * `post /v1/wishlists/{wishlistId}` share `POST /wishlists`; `Add table wishlist_members (...)` and
 * `wishlist_members table: append-only` share `wishlist members`.
 */
export function contractKey(change: string): string {
  const s = subject(change);
  return s.route ?? (s.tokens.length > 0 ? s.tokens.join(" ") : normalize(change));
}

/**
 * What a declared contract or data change commits to, beyond its wording. Agents describe the
 * same contract in different words (an implementer and a test author), so only these facts can
 * disagree: removal, the status codes it returns, and the data model it stores.
 */
function signature(text: string) {
  return {
    removes: /\b(remove|removes|delete the route|drop|drops|deprecate|deprecates)\b/.test(text),
    statuses: new Set(text.match(/\b[1-5]\d\d\b/g) ?? []),
    model: /append[- ]only|event log|immutable/.test(text)
      ? "append_only"
      : /mutable|update(s|d)? in place|overwrite/.test(text)
        ? "mutable"
        : null,
  };
}

/** Why two declarations of one contract disagree, or null when they are compatible. */
function disagree(a: string, b: string): string | null {
  const x = signature(a);
  const y = signature(b);
  if (x.removes !== y.removes) return "one removes it";
  if (x.statuses.size > 0 && y.statuses.size > 0 && ![...x.statuses].some((s) => y.statuses.has(s)))
    return "different status codes";
  if (x.model && y.model && x.model !== y.model) return `${x.model} vs ${y.model}`;
  return null;
}

/** True when the protected resource is the subject the change starts with, not a passing mention. */
function touchesProtected(change: string, resource: string): boolean {
  const want = tokens(resource);
  const have = subject(change).tokens;
  return want.length > 0 && want.every((t, i) => have[i] === t);
}

/** Numbered migration files, for example `migrations/0003_wishlists.sql`. */
const MIGRATION_FILE = /(?:^|\/)migrations\/(?:.*\/)?(\d+)_[^/]+\.sql$/;

function migrationNumbers(cs: ComposableChangeSet): number[] {
  return (cs.intent.changeSet?.files ?? []).flatMap((f) => {
    const m = MIGRATION_FILE.exec(f);
    return m?.[1] ? [Number(m[1])] : [];
  });
}

/**
 * Version of the composition rules in this file. It is part of the Candidate composition key
 * (AGENTS.md section 60), so a rules change gives the same ChangeSets a fresh Candidate and the
 * Candidate rejected under the old rules stays on record with its Evidence (section 42.9).
 * Bump it whenever `checkCompatibility` accepts or rejects a different set of compositions.
 * 2: two declarations of one contract conflict only on removal vs not, disjoint status codes, or
 * append-only vs mutable data model, not on wording.
 */
export const COMPOSITION_RULES_VERSION = 2;

/**
 * Returns the first incompatibility, checked in this order: base generation, dependencies, protected
 * invariants, contracts, migration order, then shared files. Semantic conflicts are reported before
 * the source-level file conflict because they explain why the futures diverge; a file overlap alone
 * is a conservative stand-in for a failed source merge until composition performs a real merge.
 */
export function checkCompatibility(
  baseGeneration: number,
  changeSets: readonly ComposableChangeSet[],
  options: CompatibilityOptions = {},
): CompatibilityResult {
  const sets = [...new Map(changeSets.map((cs) => [cs.id, cs])).values()];

  for (const cs of sets) {
    if (cs.baseGeneration !== baseGeneration) {
      return {
        ok: false,
        kind: "base_mismatch",
        detail: `${cs.id} is based on S${cs.baseGeneration}, composition is based on S${baseGeneration}`,
      };
    }
  }

  const ids = new Set(sets.map((cs) => cs.id));
  for (const cs of sets) {
    const missing = (cs.dependsOn ?? []).filter((dep) => !ids.has(dep));
    if (missing.length > 0) {
      return {
        ok: false,
        kind: "unsatisfied_dependency",
        detail: `${cs.id} depends on ${missing.join(", ")}, which is not in the composition`,
      };
    }
  }

  for (const cs of sets) {
    for (const change of [...cs.intent.expectedContractChanges, ...cs.intent.expectedDataChanges]) {
      const hit = options.protectedResources?.find((r) => touchesProtected(change, r));
      if (hit) {
        return {
          ok: false,
          kind: "invariant_violation",
          detail: `${cs.id} declares a change to protected resource ${hit}: ${change}`,
        };
      }
    }
  }

  const dismissed = new Set(options.dismissedContractKeys ?? []);
  for (const field of ["expectedContractChanges", "expectedDataChanges"] as const) {
    const seen = new Map<string, { id: string; text: string }>();
    for (const cs of sets) {
      for (const change of cs.intent[field]) {
        const key = contractKey(change);
        if (dismissed.has(key)) continue;
        const prior = seen.get(key);
        const disagreement = prior && prior.id !== cs.id && disagree(prior.text, normalize(change));
        if (prior && disagreement) {
          return {
            ok: false,
            kind: "contract_conflict",
            detail: `${prior.id} and ${cs.id} change ${key} incompatibly (${disagreement}): "${prior.text}" vs "${normalize(change)}"`,
          };
        }
        if (!prior) seen.set(key, { id: cs.id, text: normalize(change) });
      }
    }
  }

  const migrationOwner = new Map<number, string>();
  for (const cs of sets) {
    for (const n of migrationNumbers(cs)) {
      const owner = migrationOwner.get(n);
      if (owner && owner !== cs.id) {
        return {
          ok: false,
          kind: "migration_order",
          detail: `${owner} and ${cs.id} both add migration number ${n}`,
        };
      }
      migrationOwner.set(n, cs.id);
    }
  }
  const byId = new Map(sets.map((cs) => [cs.id, cs]));
  for (const cs of sets) {
    const own = migrationNumbers(cs);
    for (const dep of cs.dependsOn ?? []) {
      const depSet = byId.get(dep);
      if (!depSet) continue;
      const depMax = Math.max(...migrationNumbers(depSet));
      const early = own.find((n) => n < depMax);
      if (early !== undefined) {
        return {
          ok: false,
          kind: "migration_order",
          detail: `${cs.id} migration ${early} runs before migration ${depMax} of its dependency ${dep}`,
        };
      }
    }
  }

  const fileOwner = new Map<string, string>();
  for (const cs of sets) {
    for (const file of new Set(cs.intent.changeSet?.files ?? [])) {
      const owner = fileOwner.get(file);
      if (owner && owner !== cs.id) {
        return {
          ok: false,
          kind: "file_conflict",
          detail: `source conflict: ${owner} and ${cs.id} both change ${file}`,
        };
      }
      fileOwner.set(file, cs.id);
    }
  }

  return { ok: true };
}
