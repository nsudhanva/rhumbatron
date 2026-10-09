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
    changeSet?:
      | {
          files: readonly string[];
          /** Dependency ChangeSets this one was built on (stacked workspace). */
          stackedOn?: readonly string[] | undefined;
          /** Files this ChangeSet itself changed; `files` also holds inherited ones. */
          ownFiles?: readonly string[] | undefined;
        }
      | undefined;
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

// The path stops before trailing punctuation: "POST /api/wishlists: creates…" names /api/wishlists.
const HTTP_ROUTE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+([^\s,;]+?)[:.,;]*(?=\s|$)/i;

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
    // The declaration removes the contract itself, not something the endpoint does ("remove
    // product from wishlist", "add/remove items"): the route, endpoint or contract is named.
    removes:
      /\b(remove|delete|drop|deprecate)s? (the |this )?(route|endpoint|api|contract)\b/.test(
        text,
      ) ||
      /\b(route|endpoint|contract) (is |gets )?(removed|deleted|deprecated|dropped)\b/.test(text) ||
      /\bno longer (exposed|available|supported)\b/.test(text),
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

/** Files the ChangeSet itself changed: inherited files of a stacked ChangeSet are not its edits. */
function ownFiles(cs: ComposableChangeSet): readonly string[] {
  return cs.intent.changeSet?.ownFiles ?? cs.intent.changeSet?.files ?? [];
}

function migrationNumbers(cs: ComposableChangeSet): number[] {
  return ownFiles(cs).flatMap((f) => {
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
 * 4: stacked workspaces. A ChangeSet stacked on another (it descends from that commit) is never in
 * contract, migration, or file conflict with it; a ChangeSet whose stacked ancestor is missing from
 * the composition is an unsatisfied dependency; overlap uses the files a ChangeSet itself changed.
 */
export const COMPOSITION_RULES_VERSION = 5;

/**
 * Transitive `stackedOn` ancestors of each ChangeSet. A pair where one is an ancestor of the other
 * shares history: the later one already merged and extended the earlier one's source.
 */
function stackAncestors(sets: readonly ComposableChangeSet[]): Map<string, Set<string>> {
  const direct = new Map(sets.map((cs) => [cs.id, cs.intent.changeSet?.stackedOn ?? []]));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string, path: Set<string>): Set<string> => {
    const known = memo.get(id);
    if (known) return known;
    const out = new Set<string>();
    for (const parent of direct.get(id) ?? []) {
      if (path.has(parent)) continue; // A cycle cannot come from real commits; do not loop.
      out.add(parent);
      for (const a of visit(parent, new Set([...path, parent]))) out.add(a);
    }
    memo.set(id, out);
    return out;
  };
  for (const cs of sets) visit(cs.id, new Set([cs.id]));
  return memo;
}

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

  // A stacked ChangeSet's commit already contains its ancestors' source: composing it without
  // them would ship their changes unselected (for example the losing side of a design fork).
  for (const cs of sets) {
    const missing = (cs.intent.changeSet?.stackedOn ?? []).filter((dep) => !ids.has(dep));
    if (missing.length > 0) {
      return {
        ok: false,
        kind: "unsatisfied_dependency",
        detail: `${cs.id} is stacked on ${missing.join(", ")}, which is not in the composition; its commit already carries that source`,
      };
    }
  }

  const ancestors = stackAncestors(sets);
  const stacked = (a: string, b: string) =>
    (ancestors.get(a)?.has(b) ?? false) || (ancestors.get(b)?.has(a) ?? false);

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
    const seen = new Map<string, { id: string; text: string }[]>();
    for (const cs of sets) {
      for (const change of cs.intent[field]) {
        const key = contractKey(change);
        if (dismissed.has(key)) continue;
        const text = normalize(change);
        const priors = seen.get(key) ?? [];
        // A stacked descendant may redefine its ancestor's contract: it built on it knowingly.
        for (const prior of priors) {
          if (prior.id === cs.id || stacked(prior.id, cs.id)) continue;
          const disagreement = disagree(prior.text, text);
          if (disagreement) {
            return {
              ok: false,
              kind: "contract_conflict",
              detail: `${prior.id} and ${cs.id} change ${key} incompatibly (${disagreement}): "${prior.text}" vs "${text}"`,
            };
          }
        }
        seen.set(key, [...priors, { id: cs.id, text }]);
      }
    }
  }

  const migrationOwners = new Map<number, string[]>();
  for (const cs of sets) {
    for (const n of new Set(migrationNumbers(cs))) {
      const owners = migrationOwners.get(n) ?? [];
      const owner = owners.find((o) => o !== cs.id && !stacked(o, cs.id));
      if (owner) {
        return {
          ok: false,
          kind: "migration_order",
          detail: `${owner} and ${cs.id} both add migration number ${n}`,
        };
      }
      migrationOwners.set(n, [...owners, cs.id]);
    }
  }
  const byId = new Map(sets.map((cs) => [cs.id, cs]));
  for (const cs of sets) {
    const own = migrationNumbers(cs);
    for (const dep of cs.dependsOn ?? []) {
      const depSet = byId.get(dep);
      if (!depSet) continue;
      if (stacked(dep, cs.id)) continue; // Inherited migrations are already in order.
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

  // Shared files between a ChangeSet and its stacked ancestor are inherited, not concurrent
  // edits. Siblings (neither stacked on the other) that both change a file are still reported.
  const fileOwners = new Map<string, string[]>();
  for (const cs of sets) {
    for (const file of new Set(ownFiles(cs))) {
      const owners = fileOwners.get(file) ?? [];
      const owner = owners.find((o) => o !== cs.id && !stacked(o, cs.id));
      if (owner) {
        return {
          ok: false,
          kind: "file_conflict",
          detail: `source conflict: ${owner} and ${cs.id} both change ${file}`,
        };
      }
      fileOwners.set(file, [...owners, cs.id]);
    }
  }

  return { ok: true };
}
