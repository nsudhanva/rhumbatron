/**
 * Criteria to keep: the acceptance criteria of other requests of the Project that went live
 * (a promoted Candidate) after this request was created. A request that plans or re-runs on code
 * that holds their work must keep every one of them working. The agents get them in the Task
 * instruction (context-compiler `keep`), and the acceptance check judges them with the request's
 * own criteria. Criteria that only restate the quality gate are left out: other checks cover them.
 * A live request that conflicts with this one (a first-come or same-requester conflict) is not
 * kept: this request was chosen to replace it.
 */

/**
 * A criterion that only restates the quality gate ("typecheck, test and contract all pass"). The
 * planner adds one to most Changes. Checks other than the acceptance check cover it.
 */
const GATE_WORDS = new Set(
  (
    "typecheck type check checks test tests unit contract lint build bun run npm all and or the " +
    "pass passes passing succeed succeeds green must should still existing are is with no errors " +
    "script scripts suite suites check checks updated update new added cover covers covered"
  ).split(" "),
);
const CHECK_WORDS = new Set(["typecheck", "test", "tests", "contract", "lint", "build"]);
export function isQualityGate(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.some((w) => CHECK_WORDS.has(w)) && words.every((w) => GATE_WORDS.has(w));
}

/** At most this many kept criteria: the newest live requests first. */
const MAX_KEPT = 12;

/** "Keep (from an earlier request): <criterion>": the prefix tells the judge and the agent why. */
export const KEEP_PREFIX = "Keep (from an earlier request): ";

/** Pure: the kept criteria from the live requests' criteria lists, newest first, deduplicated. */
export function keptCriteria(lists: readonly string[][], own: readonly string[]): string[] {
  const seen = new Set(own.map((c) => c.trim().toLowerCase()));
  const out: string[] = [];
  for (const list of lists)
    for (const criterion of list) {
      const key = criterion.trim().toLowerCase();
      if (!key || seen.has(key) || isQualityGate(criterion)) continue;
      seen.add(key);
      out.push(criterion);
      if (out.length >= MAX_KEPT) return out;
    }
  return out;
}

/** The kept criteria of one Change: one indexed D1 read. */
export async function loadKeptCriteria(db: D1Database, changeId: string): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT ch.acceptance_criteria_json, me.acceptance_criteria_json AS own
       FROM changes me
       JOIN changes ch ON ch.project_id = me.project_id AND ch.id != me.id
       JOIN candidates c ON c.change_id = ch.id AND c.status = 'promoted'
       WHERE me.id = ? AND c.updated_at > me.created_at
         -- A request that conflicts with this one was replaced by it (first come, apply theirs):
         -- its criteria cannot hold together with this request's, so they are not kept.
         AND NOT EXISTS (SELECT 1 FROM request_conflicts rc
           WHERE rc.verdict = 'conflicting' AND rc.policy IN ('first_come', 'same_requester')
             AND ((rc.change_a = ch.id AND rc.change_b = me.id) OR (rc.change_a = me.id AND rc.change_b = ch.id)))
       ORDER BY c.updated_at DESC LIMIT 10`,
    )
    .bind(changeId)
    .all<{ acceptance_criteria_json: string | null; own: string | null }>();
  const results = rows.results ?? [];
  if (results.length === 0) return [];
  const parse = (json: string | null) => {
    try {
      const value = JSON.parse(json ?? "[]") as unknown;
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  };
  return keptCriteria(
    results.map((r) => parse(r.acceptance_criteria_json)),
    parse(results[0]?.own ?? null),
  );
}
