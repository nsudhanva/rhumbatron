// Deterministic semantic-conflict first pass. Pure; no model calls.
// The detector compares typed Intent fields only. A model never confirms a conflict here: `review`
// hands an unclear pair to Clef-flash or Sonnet, `fork_candidates` lets executable evidence decide.
import type {
  ConflictAction,
  ConflictReport,
  ConflictSeverity,
  ConflictSignal,
  ConflictSignalKind,
  ConflictState,
  Intent,
} from "@rhumbatron/protocol";
import type { Integration } from "./integrate.ts";
import {
  assumptionsContradict,
  incompatibleModels,
  normalizeEntity,
  normalizeFile,
  normalizeResource,
  normalizeShape,
  normalizeTarget,
  resourceOverlap,
} from "./normalize.ts";

export type DetectOptions = {
  /** Protected resources from the Project policy, relative or absolute. */
  protectedResources?: readonly string[];
  /**
   * Exact Work Graph edges: Task ID to the Task IDs it depends on. A dependent Task builds on its
   * upstream Task, so shared resources and files between them are expected. Contract, data, and
   * assumption conflicts between them are still reported.
   */
  dependsOn?: Readonly<Record<string, readonly string[]>>;
  /** Return benign pairs as `none` + `dismiss`, so callers can record a Decision Receipt. Default true. */
  includeDismissed?: boolean;
  /**
   * Advisory Claim contention (ADR 0015): `agentId` ran on `resource` while `holderAgentId` held
   * its Claim. A contended pair is at least `suspected`; it never confirms a conflict alone.
   */
  contentions?: readonly ClaimContention[];
};

export type ClaimContention = {
  resource: string;
  agentId: string;
  holderAgentId: string;
  holderClaimId: string;
};

const SIGNAL_ORDER: readonly ConflictSignalKind[] = [
  "contract_conflict",
  "data_model_conflict",
  "assumption_conflict",
  "invariant_reference",
  "contract_overlap",
  "data_overlap",
  "file_overlap",
  "resource_overlap",
];

const VERB = { add: "adds", modify: "modifies", remove: "removes" } as const;

/** Code-unit comparison: the same order on every runtime and locale. */
const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

const ref = (intent: Intent, field: string, index: number) =>
  `intent:${intent.intentId}:${field}:${index}`;

/** Only `add` contract and data changes. An Intent with no typed changes is additive. */
function isAdditive(intent: Intent): boolean {
  return (
    intent.expectedContractChanges.every((c) => c.kind === "add") &&
    intent.expectedDataChanges.every((d) => d.kind === "add")
  );
}

/** Plausible means the Intent names concrete changes that executable checks can exercise. */
function isPlausible(intent: Intent): boolean {
  return (
    intent.expectedFiles.length +
      intent.expectedContractChanges.length +
      intent.expectedDataChanges.length >
    0
  );
}

/**
 * True when a Work Graph path joins the two Tasks, in either direction. The later Task runs on a
 * workspace that holds the earlier Task's ChangeSet, so the pair is never two rival designs: a
 * later Task that breaks the earlier work fails the Candidate's checks instead.
 */
function ordered(a: Intent, b: Intent, dependsOn: DetectOptions["dependsOn"]): boolean {
  if (!dependsOn) return false;
  const reaches = (from: string, to: string) => {
    const seen = new Set<string>();
    const queue = [...(dependsOn[from] ?? [])];
    while (queue.length > 0) {
      const next = queue.shift() as string;
      if (next === to) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(dependsOn[next] ?? []));
    }
    return false;
  };
  return reaches(a.taskId, b.taskId) || reaches(b.taskId, a.taskId);
}

type SharedResource = { resource: string; overlap: "exact" | "prefix"; refs: string[] };

function sharedResources(a: Intent, b: Intent): SharedResource[] {
  const out = new Map<string, SharedResource>();
  a.semanticResources.forEach((ra, i) => {
    b.semanticResources.forEach((rb, j) => {
      const na = normalizeResource(ra);
      const nb = normalizeResource(rb);
      const overlap = resourceOverlap(na, nb);
      if (overlap === "none") return;
      // The more specific key names the shared resource.
      const resource = na.length >= nb.length ? na : nb;
      const existing = out.get(resource);
      const refs = [ref(a, "resource", i), ref(b, "resource", j)];
      if (!existing) out.set(resource, { resource, overlap, refs });
      else {
        if (overlap === "exact") existing.overlap = "exact";
        existing.refs.push(...refs);
      }
    });
  });
  return [...out.values()].sort((x, y) => cmp(x.resource, y.resource));
}

function compareContracts(a: Intent, b: Intent): ConflictSignal[] {
  const signals: ConflictSignal[] = [];
  a.expectedContractChanges.forEach((ca, i) => {
    b.expectedContractChanges.forEach((cb, j) => {
      const target = normalizeTarget(ca.target);
      if (target !== normalizeTarget(cb.target)) return;
      const evidenceRefs = [ref(a, "contract", i), ref(b, "contract", j)];
      const sa = ca.shape === undefined ? undefined : normalizeShape(ca.shape);
      const sb = cb.shape === undefined ? undefined : normalizeShape(cb.shape);
      let severity: ConflictSeverity;
      let detail: string;
      if (ca.kind === "remove" && cb.kind === "remove") {
        severity = "benign";
        detail = `both remove ${target}`;
      } else if (ca.kind === "remove" || cb.kind === "remove") {
        severity = "hard";
        detail = `${target}: one Intent removes it, the other ${VERB[ca.kind === "remove" ? cb.kind : ca.kind]} it`;
      } else if (sa !== undefined && sb !== undefined && sa !== sb) {
        severity = "hard";
        detail = `${target}: incompatible shapes ${sa} vs ${sb}`;
      } else if (sa !== undefined && sa === sb) {
        severity = "benign";
        detail = `${target}: same shape ${sa}`;
      } else {
        severity = "soft";
        detail = `${target}: both ${ca.kind === cb.kind ? ca.kind : "change"} it, shape not declared`;
      }
      signals.push({
        kind: severity === "hard" ? "contract_conflict" : "contract_overlap",
        severity,
        detail,
        evidenceRefs,
      });
    });
  });
  return signals;
}

function compareData(a: Intent, b: Intent, shared: readonly SharedResource[]): ConflictSignal[] {
  const signals: ConflictSignal[] = [];
  const exactShare = shared.some((s) => s.overlap === "exact");
  const anyShare = shared.length > 0;
  a.expectedDataChanges.forEach((da, i) => {
    b.expectedDataChanges.forEach((db, j) => {
      const evidenceRefs = [ref(a, "data", i), ref(b, "data", j)];
      const ea = normalizeEntity(da.entity);
      const eb = normalizeEntity(db.entity);
      const models = `${da.model} vs ${db.model}`;
      if (ea === eb) {
        if (incompatibleModels(da.model, db.model)) {
          signals.push({
            kind: "data_model_conflict",
            severity: "hard",
            detail: `${ea}: incompatible storage models ${models}`,
            evidenceRefs,
          });
        } else if ((da.kind === "remove") !== (db.kind === "remove")) {
          signals.push({
            kind: "data_model_conflict",
            severity: "hard",
            detail: `${ea}: one Intent removes it, the other ${VERB[da.kind === "remove" ? db.kind : da.kind]} it`,
            evidenceRefs,
          });
        } else if (da.kind === "add" && db.kind === "add" && da.model === db.model) {
          signals.push({
            kind: "data_overlap",
            severity: "benign",
            detail: `${ea}: both add to it with model ${da.model}`,
            evidenceRefs,
          });
        } else {
          signals.push({
            kind: "data_overlap",
            severity: "soft",
            detail: `${ea}: both change it (${da.kind}/${db.kind}, ${models})`,
            evidenceRefs,
          });
        }
        return;
      }
      // Different entities that represent one shared resource with incompatible semantics.
      if (anyShare && incompatibleModels(da.model, db.model)) {
        signals.push({
          kind: exactShare ? "data_model_conflict" : "data_overlap",
          severity: exactShare ? "hard" : "soft",
          detail: `${ea} vs ${eb}: ${models} for ${exactShare ? "the same" : "a related"} resource`,
          evidenceRefs,
        });
      }
    });
  });
  return signals;
}

function compareAssumptions(a: Intent, b: Intent): ConflictSignal[] {
  const signals: ConflictSignal[] = [];
  a.assumptions.forEach((sa, i) => {
    b.assumptions.forEach((sb, j) => {
      if (!assumptionsContradict(sa, sb)) return;
      signals.push({
        kind: "assumption_conflict",
        severity: "soft",
        detail: `"${sa}" contradicts "${sb}"`,
        evidenceRefs: [ref(a, "assumption", i), ref(b, "assumption", j)],
      });
    });
  });
  return signals;
}

function sharedFiles(a: Intent, b: Intent): { files: string[]; refs: string[] } {
  const files = new Set<string>();
  const refs: string[] = [];
  a.expectedFiles.forEach((fa, i) => {
    b.expectedFiles.forEach((fb, j) => {
      const f = normalizeFile(fa);
      if (f !== normalizeFile(fb)) return;
      files.add(f);
      refs.push(ref(a, "file", i), ref(b, "file", j));
    });
  });
  return { files: [...files].sort(), refs };
}

/** Contention between the two Intents' agents, in either direction, deduplicated by resource. */
function contentionsBetween(
  a: Intent,
  b: Intent,
  contentions: readonly ClaimContention[] | undefined,
): ClaimContention[] {
  if (!contentions || a.agentId === b.agentId) return [];
  const pair = new Set([a.agentId, b.agentId]);
  const byResource = new Map<string, ClaimContention>();
  for (const c of contentions) {
    if (c.agentId === c.holderAgentId || !pair.has(c.agentId) || !pair.has(c.holderAgentId)) {
      continue;
    }
    const resource = normalizeResource(c.resource);
    if (!byResource.has(resource)) byResource.set(resource, { ...c, resource });
  }
  return [...byResource.values()].sort((x, y) => cmp(x.resource, y.resource));
}

function protectedHit(resources: readonly string[], protectedResources: readonly string[]) {
  const guards = protectedResources.map(normalizeResource);
  return resources.filter((r) => guards.some((g) => resourceOverlap(r, g) !== "none")).sort();
}

function classify(
  signals: readonly ConflictSignal[],
  a: Intent,
  b: Intent,
): { state: ConflictState; recommendedAction: ConflictAction } {
  if (signals.some((s) => s.severity === "hard")) {
    const fork = isPlausible(a) && isPlausible(b);
    return { state: "confirmed", recommendedAction: fork ? "fork_candidates" : "review" };
  }
  if (signals.some((s) => s.severity === "soft")) {
    return { state: "suspected", recommendedAction: "review" };
  }
  return { state: "none", recommendedAction: "dismiss" };
}

function comparePair(a: Intent, b: Intent, options: DetectOptions): ConflictReport | null {
  // A Work Graph path between the two Tasks: one builds on the other, never a rival design.
  if (ordered(a, b, options.dependsOn)) return null;
  const shared = sharedResources(a, b);
  const files = sharedFiles(a, b);
  const contracts = compareContracts(a, b);
  const data = compareData(a, b, shared);
  const contended = contentionsBetween(a, b, options.contentions);
  if (
    shared.length === 0 &&
    files.files.length === 0 &&
    contracts.length + data.length === 0 &&
    contended.length === 0
  ) {
    return null;
  }

  // Overlap that only adds is expected and benign.
  const expected = isAdditive(a) && isAdditive(b);
  const signals: ConflictSignal[] = [...contracts, ...data, ...compareAssumptions(a, b)];
  if (shared.length > 0) {
    signals.push({
      kind: "resource_overlap",
      severity: expected ? "benign" : "soft",
      detail: shared.map((s) => `${s.overlap} ${s.resource}`).join(", "),
      evidenceRefs: shared.flatMap((s) => s.refs),
    });
  }
  if (contended.length > 0) {
    // Both agents worked on one resource at the same time. Even additive or Work Graph-ordered
    // overlap then needs review; only the typed Intent fields can make it `confirmed`.
    signals.push({
      kind: "resource_overlap",
      severity: "soft",
      detail: `claim contention on ${contended
        .map((c) => `${c.resource} (${c.agentId} ran while ${c.holderAgentId} held the Claim)`)
        .join(", ")}`,
      evidenceRefs: contended.map((c) => `claim:${c.holderClaimId}`),
    });
  }
  if (files.files.length > 0) {
    signals.push({
      kind: "file_overlap",
      severity: expected ? "benign" : "soft",
      detail: files.files.join(", "),
      evidenceRefs: files.refs,
    });
  }

  const touched =
    shared.length > 0
      ? shared.map((s) => s.resource)
      : [...a.semanticResources, ...b.semanticResources].map(normalizeResource);
  const guarded = protectedHit(touched, options.protectedResources ?? []);
  if (guarded.length > 0) {
    signals.push({
      kind: "invariant_reference",
      severity: "soft",
      detail: `protected resource ${[...new Set(guarded)].join(", ")}`,
      evidenceRefs: [],
    });
  }

  signals.sort(
    (x, y) =>
      SIGNAL_ORDER.indexOf(x.kind) - SIGNAL_ORDER.indexOf(y.kind) || cmp(x.detail, y.detail),
  );
  const resource =
    shared.reduce<string | undefined>(
      (best, s) => (best === undefined || s.resource.length > best.length ? s.resource : best),
      undefined,
    ) ??
    contended[0]?.resource ??
    [...a.semanticResources, ...b.semanticResources].map(normalizeResource).sort()[0] ??
    "unscoped";
  return {
    intentIds: [a.intentId, b.intentId],
    resource,
    signals,
    ...classify(signals, a, b),
  };
}

/**
 * Compares every pair of Intents from different Tasks and returns one report per related pair,
 * sorted by intent IDs. Unrelated pairs produce nothing. Intents of the same Task are versions of
 * one plan, so they are never compared with each other.
 */
export function detectConflicts(
  intents: readonly Intent[],
  options: DetectOptions = {},
): ConflictReport[] {
  const unique = [...new Map(intents.map((i) => [i.intentId, i])).values()].sort((x, y) =>
    cmp(x.intentId, y.intentId),
  );
  const reports: ConflictReport[] = [];
  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) {
      const a = unique[i];
      const b = unique[j];
      if (!a || !b || a.taskId === b.taskId) continue;
      const report = comparePair(a, b, options);
      if (report === null) continue;
      if (report.recommendedAction === "dismiss" && options.includeDismissed === false) continue;
      reports.push(report);
    }
  }
  return reports;
}

export type ForkDecision =
  | { kind: "fork"; candidateIntentIds: [string, string]; reason: string }
  /** Complementary Tasks (integrate.ts): the dependent Task re-runs on the other's ChangeSet. */
  | ({ kind: "integrate" } & Integration)
  | { kind: "no_fork"; reason: "benign_overlap" | "needs_review" | "already_resolved" }
  | { kind: "blocked"; reason: "candidate_limit"; maxCandidates: number };

/**
 * Fork only when both approaches are plausible and executable evidence can pick a
 * winner, which the detector expresses as `fork_candidates` on a confirmed conflict. Forking adds
 * two Candidates, so it is blocked when that would pass `maxCandidates` (default: 3).
 * A forkable conflict between complementary Tasks (`integration`, from `integrationFor`) is
 * `integrate` instead: the two sides are parts of one plan, and no Candidate is added.
 */
export function forkDecision(
  report: ConflictReport,
  limits: { activeCandidates?: number; maxCandidates?: number } = {},
  integration: Integration | null = null,
): ForkDecision {
  const maxCandidates = limits.maxCandidates ?? 3;
  if (report.state === "resolved") return { kind: "no_fork", reason: "already_resolved" };
  if (report.recommendedAction === "dismiss") return { kind: "no_fork", reason: "benign_overlap" };
  const forkable =
    report.recommendedAction === "fork_candidates" &&
    (report.state === "confirmed" || report.state === "fork_required");
  if (!forkable) return { kind: "no_fork", reason: "needs_review" };
  if (integration) return { kind: "integrate", ...integration };
  if ((limits.activeCandidates ?? 0) + 2 > maxCandidates) {
    return { kind: "blocked", reason: "candidate_limit", maxCandidates };
  }
  const hard = report.signals.filter((s) => s.severity === "hard").map((s) => s.detail);
  return {
    kind: "fork",
    candidateIntentIds: [report.intentIds[0], report.intentIds[1]],
    reason: `${report.resource}: ${hard.join("; ")}`,
  };
}
