import { CheckExpectation, EvidenceRecord } from "@rhumbatron/protocol";
import { z } from "zod";

/**
 * Tolerant readers for stored Candidate and Evidence rows. One
 * unexpected row must not fail a whole read model:
 *
 * - `score_json` holds the verification gate, or other integration state (for example a `rebase`
 *   marker on a rejected Candidate). Only a gate-shaped value reads as a gate; anything else is
 *   null ("no gate recorded").
 * - `plan_json` can hold check kinds this API does not list yet. The read model keeps any kind; a
 *   value that is not a plan at all reads as null ("no plan recorded").
 * - An Evidence row that does not parse is dropped, so its check reads as a gap, never a pass.
 */

export const GateView = z.object({
  promotable: z.boolean(),
  gaps: z.array(z.object({ checkId: z.string(), reason: z.string() })),
  humanApprovalRequired: z.boolean().optional(),
  p95Ms: z.number().optional(),
});
export type GateView = z.infer<typeof GateView>;

/** A plan check as stored, with any check kind. */
const CheckView = z.object({
  checkId: z.string().min(1),
  kind: z.string().min(1),
  reason: z.string(),
  command: z.string().optional(),
  procedure: z.string().optional(),
  timeoutMs: z.number(),
  required: z.boolean(),
  expected: CheckExpectation,
  evidenceOutput: z.array(z.string()).optional(),
});

export const PlanView = z.object({
  candidateId: z.string(),
  checks: z.array(CheckView),
  requiredCheckIds: z.array(z.string()),
  humanApprovalRequired: z.boolean(),
  policyVersion: z.string(),
});
export type PlanView = z.infer<typeof PlanView>;

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function read<T extends z.ZodType>(schema: T, text: string | null): z.output<T> | null {
  const parsed = schema.safeParse(parseJson(text));
  return parsed.success ? parsed.data : null;
}

export const readGate = (scoreJson: string | null): GateView | null => read(GateView, scoreJson);

export const readPlan = (planJson: string | null): PlanView | null => read(PlanView, planJson);

export const readStringArray = (json: string | null): string[] =>
  read(z.array(z.string()), json) ?? [];

export type EvidenceRow = {
  id: string;
  candidate_id: string;
  check_id: string | null;
  kind: string;
  status: string;
  coverage: string;
  summary: string | null;
  r2_key: string | null;
  content_hash: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  metrics_json: string | null;
  source_refs_json: string | null;
};

/** One Evidence row as an `EvidenceRecord`, or null when the row does not satisfy the contract. */
export function readEvidence(r: EvidenceRow): EvidenceRecord | null {
  const metrics = read(z.record(z.string(), z.number()), r.metrics_json);
  const parsed = EvidenceRecord.safeParse({
    evidenceId: r.id,
    candidateId: r.candidate_id,
    checkId: r.check_id ?? r.kind,
    kind: r.kind,
    status: r.status,
    coverage: r.coverage,
    startedAt: r.started_at ?? r.created_at,
    completedAt: r.completed_at ?? r.created_at,
    summary: r.summary ?? "",
    contentHash: r.content_hash,
    ...(r.r2_key ? { r2Key: r.r2_key } : {}),
    ...(metrics ? { metrics } : {}),
    sourceRefs: readStringArray(r.source_refs_json),
  });
  return parsed.success ? parsed.data : null;
}
