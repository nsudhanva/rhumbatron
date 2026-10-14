/**
 * Criteria to keep: the acceptance criteria of other requests of the Project that went live
 * (a promoted Candidate) after this request was created. A request that plans or re-runs on code
 * that holds their work must keep every one of them working. The agents get them in the Task
 * instruction (context-compiler `keep`), and the acceptance check judges them with the request's
 * own criteria. Criteria that only restate the quality gate are left out: other checks cover them.
 * A live request that conflicts with this one (a first-come or same-requester conflict) is not
 * kept: this request was chosen to replace it. A live request that the live-removal check named,
 * when the requester answered "Remove them", is not kept either. The requester's own requests are
 * not kept: the newer request states that person's current intent.
 */

/** The live-removal question ID (`live-removal.ts`); an answered one is never asked again. */
export const KEEP_LIVE_QUESTION = "keep_live";
/** The answer that lets the named live requests go. */
export const REMOVE_LIVE_ANSWER = "Remove them";

/**
 * A criterion that only restates the quality gate ("typecheck, test and contract all pass", "all
 * existing API routes and tests continue to pass") or only guards against accidental breakage
 * ("other pages and API routes behave as before"). The planner adds one to most Changes. The
 * build, unit, contract, and preview checks cover it. It names a check and a passing word, or a
 * guard word, and every other word is generic: no product noun is left. The acceptance check does
 * not judge such a criterion, and it never makes a conflict with another request.
 */
const CHECK_WORDS = new Set([
  "typecheck",
  "test",
  "tests",
  "contract",
  "contracts",
  "lint",
  "build",
  "checks",
]);
const PASS_WORDS = new Set([
  "pass",
  "passes",
  "passing",
  "succeed",
  "succeeds",
  "green",
  "work",
  "works",
  "working",
]);
const GENERIC_WORDS = new Set(
  (
    "type check suite suites script scripts unit api apis route routes endpoint endpoints existing " +
    "all and or the a an of in to for with on are is be must should still continue continues keep " +
    "keeps remain remains stay stays updated update new added cover covers covered no errors error " +
    "bun run npm app current every each other page pages rest everything else feature features as " +
    "same way nothing"
  ).split(" "),
);
const GUARD_WORDS = new Set([
  "behave",
  "behaves",
  "before",
  "unchanged",
  "regress",
  "regression",
  "regressions",
  "break",
  "broken",
  "breaks",
]);
export function isQualityGate(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const known = (w: string) =>
    CHECK_WORDS.has(w) || PASS_WORDS.has(w) || GUARD_WORDS.has(w) || GENERIC_WORDS.has(w);
  return (
    ((words.some((w) => CHECK_WORDS.has(w)) && words.some((w) => PASS_WORDS.has(w))) ||
      words.some((w) => GUARD_WORDS.has(w))) &&
    words.every(known)
  );
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
       WHERE me.id = ?1 AND c.updated_at > me.created_at AND ch.created_by != me.created_by
         -- A request that conflicts with this one was replaced by it (first come, apply theirs):
         -- its criteria cannot hold together with this request's, so they are not kept.
         AND NOT EXISTS (SELECT 1 FROM request_conflicts rc
           WHERE rc.verdict = 'conflicting' AND rc.policy IN ('first_come', 'same_requester')
             AND ((rc.change_a = ch.id AND rc.change_b = me.id) OR (rc.change_a = me.id AND rc.change_b = ch.id)))
         -- The requester chose to remove it (live-removal check, answer "Remove them").
         AND NOT (EXISTS (SELECT 1 FROM live_removals lr WHERE lr.change_id = me.id AND lr.removed_change_id = ch.id)
           AND EXISTS (SELECT 1 FROM json_each(COALESCE(me.clarification_answers_json, '[]')) a
             WHERE json_extract(a.value, '$.questionId') = ?2 AND json_extract(a.value, '$.text') = ?3))
       ORDER BY c.updated_at DESC LIMIT 10`,
    )
    .bind(changeId, KEEP_LIVE_QUESTION, REMOVE_LIVE_ANSWER)
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
