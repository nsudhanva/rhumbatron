import type { EvidenceRecord } from "@rhumbatron/protocol";

/** One `evidence_index` row (migrations 0001 and 0007). */
export type EvidenceRow = {
  id: string;
  candidate_id: string;
  check_id: string | null;
  kind: string;
  status: EvidenceRecord["status"];
  coverage: EvidenceRecord["coverage"];
  summary: string;
  r2_key: string | null;
  content_hash: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  metrics_json: string | null;
  source_refs_json: string;
};

/** Maps a row to its section 34.3 record. Rows from before 0007 fall back to their kind and time. */
export function toRecord(row: EvidenceRow): EvidenceRecord {
  return {
    evidenceId: row.id,
    candidateId: row.candidate_id,
    checkId: row.check_id ?? row.kind,
    kind: row.kind,
    status: row.status,
    coverage: row.coverage,
    startedAt: row.started_at ?? row.created_at,
    completedAt: row.completed_at ?? row.created_at,
    summary: row.summary,
    contentHash: row.content_hash,
    ...(row.r2_key ? { r2Key: row.r2_key } : {}),
    ...(row.metrics_json
      ? { metrics: JSON.parse(row.metrics_json) as Record<string, number> }
      : {}),
    sourceRefs: JSON.parse(row.source_refs_json) as string[],
  };
}
