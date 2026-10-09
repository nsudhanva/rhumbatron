import { Badge, Text } from "@cloudflare/kumo";
import { CheckCircle, Circle, MinusCircle, WarningCircle, XCircle } from "@phosphor-icons/react";
import type { CandidateDetail, EvidenceRecord, VerificationCheck } from "../lib/api";

/**
 * Verification Evidence for one Candidate (AGENTS.md sections 34.3, 34.4.1). Only a
 * `checked_supported` pass is green. A check that did not run, timed out, or found no signal is a
 * gap and is drawn as one, never as a pass.
 */

type Verdict = "pass" | "fail" | "gap" | "pending";

const COVERAGE_LABEL: Record<EvidenceRecord["coverage"], string> = {
  checked_supported: "checked, evidence supports result",
  checked_no_signal: "ran, no signal",
  not_checked: "not checked",
};

function verdict(record: EvidenceRecord | undefined, finished: boolean): Verdict {
  if (!record) return finished ? "gap" : "pending";
  if (record.status === "pass" && record.coverage === "checked_supported") return "pass";
  if (record.status === "fail" && record.coverage === "checked_supported") return "fail";
  return "gap";
}

const VERDICT_STYLE: Record<
  Verdict,
  { label: string; variant: "success" | "error" | "warning" | "secondary"; row: string }
> = {
  pass: { label: "Pass", variant: "success", row: "border-kumo-success" },
  fail: { label: "Fail", variant: "error", row: "border-kumo-danger" },
  gap: { label: "Gap", variant: "warning", row: "border-dashed border-kumo-warning" },
  pending: { label: "Pending", variant: "secondary", row: "border-kumo-line opacity-70" },
};

function VerdictIcon({ value }: { value: Verdict }) {
  const props = { size: 20, weight: "fill" as const, className: "mt-0.5 shrink-0" };
  if (value === "pass")
    return <CheckCircle {...props} className={`${props.className} text-kumo-success`} />;
  if (value === "fail")
    return <XCircle {...props} className={`${props.className} text-kumo-danger`} />;
  if (value === "gap")
    return <WarningCircle {...props} className={`${props.className} text-kumo-warning`} />;
  return <Circle {...props} weight="regular" className={`${props.className} text-kumo-subtle`} />;
}

function seconds(record: EvidenceRecord) {
  const ms = Date.parse(record.completedAt) - Date.parse(record.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? `${(ms / 1000).toFixed(1)} s` : "";
}

function expectation(check: VerificationCheck) {
  const e = check.expected;
  if (e.kind === "exit_code") return `exit ${e.code}`;
  if (e.kind === "metric_below") return `${e.metric} < ${e.threshold}`;
  return "manual procedure";
}

function CheckRow({
  check,
  record,
  required,
  finished,
}: {
  check: VerificationCheck | undefined;
  record: EvidenceRecord | undefined;
  required: boolean;
  finished: boolean;
}) {
  const value = verdict(record, finished);
  const style = VERDICT_STYLE[value];
  const id = check?.checkId ?? record?.checkId ?? "check";
  return (
    <li className={`flex gap-3 rounded-lg border-2 bg-kumo-base px-3 py-2.5 ${style.row}`}>
      <VerdictIcon value={value} />
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Text bold>{id}</Text>
          <Badge variant={style.variant}>{style.label}</Badge>
          <Badge variant="secondary">{check?.kind ?? record?.kind}</Badge>
          {required ? (
            <Badge variant="info">required</Badge>
          ) : (
            <Badge variant="secondary">optional</Badge>
          )}
          {record && (
            <span className="ml-auto text-xs text-kumo-subtle">
              {record.status} · {COVERAGE_LABEL[record.coverage]}{" "}
              {seconds(record) && `· ${seconds(record)}`}
            </span>
          )}
        </div>
        {check && (
          <Text variant="secondary">
            {check.command ? (
              <code className="font-mono text-xs">{check.command}</code>
            ) : (
              "Procedure, not automated yet"
            )}{" "}
            · expects {expectation(check)}
          </Text>
        )}
        {record ? (
          <Text>{record.summary}</Text>
        ) : (
          <Text variant="secondary">
            {finished
              ? "No Evidence recorded. This is a gap, not a pass."
              : "Waiting for the Sandbox…"}
          </Text>
        )}
        {record?.metrics && Object.keys(record.metrics).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(record.metrics).map(([name, value]) => (
              <Badge key={name} variant="secondary">
                {name} {Number.isInteger(value) ? value : value.toFixed(3)}
              </Badge>
            ))}
          </div>
        )}
        {record?.r2Key && (
          <Text variant="secondary">
            <span className="font-mono text-xs">
              {record.r2Key} · {record.contentHash.slice(0, 19)}
            </span>
          </Text>
        )}
      </div>
    </li>
  );
}

/** The gate result. Promotion needs every required check satisfied by executable Evidence. */
function GateSummary({ candidate }: { candidate: CandidateDetail }) {
  const gate = candidate.gate;
  if (!gate) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-kumo-line px-3 py-2">
        <MinusCircle size={20} className="text-kumo-subtle" />
        <Text>Gate not computed yet: verification is {candidate.status}.</Text>
      </div>
    );
  }
  if (gate.promotable) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-kumo-success-tint px-3 py-2 text-kumo-success">
        <CheckCircle size={20} weight="fill" />
        <Text>
          Every required check passed with executable Evidence.
          {gate.humanApprovalRequired ? " Human approval is still required before promotion." : ""}
        </Text>
      </div>
    );
  }
  return (
    <div className="grid gap-1.5 rounded-lg bg-kumo-danger-tint px-3 py-2 text-kumo-danger">
      <div className="flex items-center gap-2">
        <XCircle size={20} weight="fill" />
        <Text bold>Not promotable</Text>
      </div>
      {candidate.statusReason && <Text>{candidate.statusReason}</Text>}
      {gate.gaps.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {gate.gaps.map((g) => (
            <Badge key={g.checkId} variant={g.reason === "failed" ? "error" : "warning"}>
              {g.checkId}: {g.reason.replace(/_/g, " ")}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

export function CandidateEvidence({
  candidate,
  evidence,
}: {
  candidate: CandidateDetail;
  evidence: EvidenceRecord[];
}) {
  const finished =
    candidate.gate !== null || ["verified", "rejected", "stale"].includes(candidate.status);
  const byCheck = new Map<string, EvidenceRecord>();
  for (const e of evidence) {
    const prior = byCheck.get(e.checkId);
    if (!prior || Date.parse(e.completedAt) >= Date.parse(prior.completedAt))
      byCheck.set(e.checkId, e);
  }
  const checks = candidate.plan?.checks ?? [];
  const required = new Set(candidate.plan?.requiredCheckIds ?? []);
  const planned = new Set(checks.map((c) => c.checkId));
  // Evidence outside the plan, for example a composition failure before any check ran.
  const extra = evidence.filter((e) => !planned.has(e.checkId));
  const supported = checks.filter(
    (c) => verdict(byCheck.get(c.checkId), finished) === "pass",
  ).length;

  return (
    <div className="grid gap-3">
      <GateSummary candidate={candidate} />
      {checks.length > 0 && (
        <Text variant="secondary">
          {supported} of {checks.length} checks passed with supporting Evidence. Gaps are shown in
          amber and never count as a pass.
        </Text>
      )}
      <ul className="grid gap-2">
        {extra.map((e) => (
          <CheckRow key={e.evidenceId} check={undefined} record={e} required finished={finished} />
        ))}
        {checks.map((check) => (
          <CheckRow
            key={check.checkId}
            check={check}
            record={byCheck.get(check.checkId)}
            required={required.has(check.checkId) || check.required}
            finished={finished}
          />
        ))}
      </ul>
      {checks.length === 0 && extra.length === 0 && (
        <Text variant="secondary">
          {finished
            ? "No Verification Plan was built for this Candidate."
            : "Composing the Candidate…"}
        </Text>
      )}
    </div>
  );
}
