import { Button } from "@cloudflare/kumo";
import { Link } from "@tanstack/react-router";
import type { WorkspaceView } from "../../lib/api";
import { formatNumber } from "../../lib/format";
import { criterion, isFinished, p95Budget, requiredTally, versionWord } from "../candidate/model";
import { StatusPill } from "../ui/status-pill";
import { CheckList } from "./check-list";
import { firstProblem, isReady, type VersionView } from "./headline";
import { statLine, versionFiles } from "./model";

/**
 * Step 3, Checks (docs/ux/research-2026-10-09.md 7.4): one version shows its check list; two or
 * more show the result sentence, one compact card per version and the link to compare them.
 * "Required checks met" counts only a pass with a recorded result, like the release gate.
 */

/** One sentence per version, winner first. */
function resultSentence(versions: VersionView[]) {
  const rank = (v: VersionView) =>
    v.candidate.status === "promoted"
      ? 0
      : isReady(v)
        ? 1
        : v.candidate.status === "rejected"
          ? 3
          : 2;
  return [...versions]
    .sort((a, b) => rank(a) - rank(b))
    .map((v) => {
      const tally = requiredTally(v.rows);
      if (v.candidate.status === "promoted" || isReady(v)) {
        return `${v.label} passed all ${formatNumber(tally.total)} required checks.`;
      }
      if (v.candidate.status === "rejected") {
        const problem = firstProblem(v);
        return `${v.label} was set aside${problem ? `: ${problem}` : ""}.`;
      }
      if (v.candidate.status === "stale") {
        return `${v.label} is out of date: another change shipped first.`;
      }
      if (!isFinished(v.candidate)) return `${v.label} is still being checked.`;
      return `${v.label} passed ${tally.met} of ${tally.total} required checks.`;
    })
    .join(" ");
}

function VersionCard({
  version,
  workspace,
}: {
  version: VersionView;
  workspace: WorkspaceView | undefined;
}) {
  const tally = requiredTally(version.rows);
  const problems = [...tally.failed, ...tally.gaps];
  const budget = p95Budget(version.candidate);
  const files = versionFiles(workspace, version.candidate);
  const finished = isFinished(version.candidate);
  return (
    <li className="grid content-start gap-1.5 rounded-lg border border-kumo-rule p-4 text-[13px]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[14px] font-semibold">{version.label}</span>
        <StatusPill
          status={version.candidate.status}
          label={versionWord(version.candidate.status)}
        />
      </div>
      <p className="tabular-nums">
        {!finished
          ? `${formatNumber(version.rows.filter((r) => r.record).length)} of ${formatNumber(version.rows.length)} checks finished`
          : problems.length > 0
            ? `Failed ${problems.length} of ${tally.total}`
            : `Passed ${tally.met} of ${tally.total}`}
      </p>
      {problems[0] && (
        <p className="text-kumo-danger">
          {criterion(problems[0], budget).title}
          {problems[0].record?.summary ? `: ${problems[0].record.summary}` : ""}
        </p>
      )}
      {files && (
        <p className="text-kumo-subtle tabular-nums">
          {statLine(files)} in {formatNumber(files.files.length)} files
        </p>
      )}
      <Link
        to="/candidates/$candidateId"
        params={{ candidateId: version.candidate.id }}
        className="text-kumo-link hover:underline"
      >
        {version.label} details
      </Link>
    </li>
  );
}

export function ChecksStep({
  changeId,
  versions,
  focus,
  workspace,
  tasksDone,
  onRunChecks,
  runPending,
  runError,
}: {
  changeId: string;
  versions: VersionView[];
  /** The version the page talks about. */
  focus: VersionView | null;
  workspace: WorkspaceView | undefined;
  /** Every task is done and no version is being checked: the checks can start. */
  tasksDone: boolean;
  onRunChecks: () => void;
  runPending: boolean;
  runError: string | null;
}) {
  const runButton = (
    <div className="grid justify-items-start gap-2">
      <Button variant="primary" loading={runPending} onClick={onRunChecks}>
        Run checks
      </Button>
      {runError && <p className="text-[13px] text-kumo-danger">{runError}</p>}
    </div>
  );
  if (versions.length === 0) {
    if (!tasksDone) {
      return <p className="text-[14px] text-kumo-subtle">Checks start after every task is done.</p>;
    }
    return (
      <div className="grid gap-3">
        <p className="text-[14px]">All tasks are done. Run the checks to build a version.</p>
        {runButton}
      </div>
    );
  }
  if (versions.length === 1 && focus) {
    return (
      <div className="grid gap-2">
        <p className="text-[14px]">{resultSentence(versions)}</p>
        <CheckList
          rows={focus.rows}
          candidate={focus.candidate}
          finished={isFinished(focus.candidate)}
        />
        {focus.candidate.status === "stale" && tasksDone && runButton}
      </div>
    );
  }
  return (
    <div className="grid gap-3">
      <p className="text-[14px]">{resultSentence(versions)}</p>
      <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3">
        {versions.map((v) => (
          <VersionCard key={v.candidate.id} version={v} workspace={workspace} />
        ))}
      </ul>
      <Link
        to="/compare/$changeId"
        params={{ changeId }}
        className="text-[13px] text-kumo-link hover:underline"
      >
        Compare versions in detail
      </Link>
    </div>
  );
}
ChecksStep.displayName = "ChecksStep";
