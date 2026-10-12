// Verification read model rows. One unexpected stored row must
// degrade that row only: `score_json` also holds non-gate integration state (a `rebase` marker on
// a rejected Candidate), plans can carry check kinds this API does not list, and an unreadable
// Evidence row must read as a gap, never as a pass.
import { describe, expect, it } from "vitest";
import { type EvidenceRow, readEvidence, readGate, readPlan } from "./candidate-read.ts";

const check = (checkId: string, kind: string) => ({
  checkId,
  kind,
  reason: "r",
  command: "bun run typecheck",
  timeoutMs: 120_000,
  required: true,
  expected: { kind: "exit_code", code: 0 },
  evidenceOutput: ["report.json"],
});

const evidenceRow = (patch: Partial<EvidenceRow> = {}): EvidenceRow => ({
  id: "ev_c1_composition",
  candidate_id: "cand_c1",
  check_id: "composition",
  kind: "composition",
  status: "fail",
  coverage: "checked_supported",
  summary: "cs_1 does not merge",
  r2_key: null,
  content_hash: "sha256:abc",
  started_at: "2026-10-11T18:03:51.048Z",
  completed_at: null,
  created_at: "2026-10-11T18:03:51.048Z",
  metrics_json: null,
  source_refs_json: '["cs_1"]',
  ...patch,
});

describe("readGate", () => {
  it("reads a gate result", () => {
    expect(readGate('{"promotable":true,"gaps":[],"humanApprovalRequired":false}')).toEqual({
      promotable: true,
      gaps: [],
      humanApprovalRequired: false,
    });
  });

  it("reads a rebase marker, a missing value, or bad JSON as no gate", () => {
    expect(readGate('{"rebase":{"token":"t","baseGeneration":1,"requested":1}}')).toBeNull();
    expect(readGate(null)).toBeNull();
    expect(readGate("{not json")).toBeNull();
  });
});

describe("readPlan", () => {
  const plan = (checks: unknown[]) =>
    JSON.stringify({
      candidateId: "cand_c1",
      checks,
      requiredCheckIds: ["build"],
      humanApprovalRequired: false,
      policyVersion: "policy-1",
    });

  it("keeps check kinds outside the protocol list", () => {
    const read = readPlan(plan([check("build", "build"), check("acceptance-1", "acceptance")]));
    expect(read?.checks.map((c) => c.kind)).toEqual(["build", "acceptance"]);
  });

  it("reads a missing or malformed plan as no plan", () => {
    expect(readPlan(null)).toBeNull();
    expect(readPlan('{"checks":"nope"}')).toBeNull();
  });
});

describe("readEvidence", () => {
  it("reads a composition failure outside any plan", () => {
    expect(readEvidence(evidenceRow())).toMatchObject({
      checkId: "composition",
      status: "fail",
      completedAt: "2026-10-11T18:03:51.048Z",
      sourceRefs: ["cs_1"],
    });
  });

  it("drops a row that breaks the contract, so its check stays a gap", () => {
    expect(readEvidence(evidenceRow({ status: "passed" }))).toBeNull();
    expect(readEvidence(evidenceRow({ coverage: "unknown" }))).toBeNull();
  });

  it("keeps the row when only optional metrics are unreadable", () => {
    const read = readEvidence(evidenceRow({ metrics_json: '{"p95Ms":"fast"}' }));
    expect(read).not.toBeNull();
    expect(read?.metrics).toBeUndefined();
  });
});
