import { Show } from "@clerk/tanstack-react-start";
import { Button, buttonVariants, cn } from "@cloudflare/kumo";
import { Columns } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AcceptanceList,
  acceptanceSummary,
  NoAcceptanceResult,
} from "../components/candidate/acceptance-list";
import { Banner } from "../components/candidate/banner";
import {
  type CheckRow,
  candidateLabels,
  candidateSentence,
  checkRows,
  formatP95,
  isActive,
  meterMax,
  p95Budget,
  p95Of,
  requiredTally,
  shortHash,
  VERDICT_STATUS,
} from "../components/candidate/model";
import { PreviewLink } from "../components/candidate/preview-link";
import { CandidateSkeleton } from "../components/candidate/skeleton";
import { CandidateEvidence } from "../components/candidate-evidence";
import { CandidatePromotion } from "../components/candidate-promotion";
import { CandidateFilesChanged } from "../components/code/files-changed";
import { DataTable, RowLink, Td, Th, TitleCell, TRow } from "../components/ui/data-table";
import { EmptyState } from "../components/ui/empty-state";
import { SegmentedSteps, ThresholdMeter } from "../components/ui/meter";
import { Mono } from "../components/ui/mono";
import { Page, PageTitle, Section } from "../components/ui/page";
import { StatCell, StatStrip } from "../components/ui/stat-strip";
import { StatusPill } from "../components/ui/status-pill";
import {
  type CandidateDetail,
  getCandidate,
  listCandidateEvidence,
  listCandidates,
  listChanges,
} from "../lib/api";
import type { CandidateView as CandidateRead } from "../lib/api-change";
import { EMPTY, formatMs, formatNumber, generation, timeAgo } from "../lib/format";

export const Route = createFileRoute("/candidates/$candidateId")({ component: CandidatePage });

/** Verification runs for minutes; poll while it is active, then stop (AGENTS.md section 39). */
const POLL_MS = 10_000;

function CandidatePage() {
  return (
    <Page>
      <Show when="signed-in">
        <CandidateView />
      </Show>
      <Show when="signed-out">
        <EmptyState
          what="Sign in to view this Candidate."
          how="Candidates belong to a Project you are a member of."
        />
      </Show>
    </Page>
  );
}

function CandidateView() {
  const { candidateId } = Route.useParams();
  const candidate = useQuery({
    queryKey: ["candidate", candidateId],
    queryFn: () => getCandidate({ data: candidateId }) as Promise<CandidateRead>,
    refetchInterval: (query) => (!query.state.data || isActive(query.state.data) ? POLL_MS : false),
  });
  const active = !candidate.data || isActive(candidate.data);
  const evidence = useQuery({
    queryKey: ["candidate-evidence", candidateId],
    queryFn: () => listCandidateEvidence({ data: candidateId }),
    refetchInterval: active ? POLL_MS : false,
  });
  const changeId = candidate.data?.changeId;
  const siblings = useQuery({
    queryKey: ["candidates", changeId],
    queryFn: () => listCandidates({ data: changeId ?? "" }),
    enabled: !!changeId,
    refetchInterval: active ? POLL_MS : false,
  });
  const projectId = candidate.data?.projectId;
  // Risk tier is only on the Change summary list; it names the rule behind the human gate.
  const changes = useQuery({
    queryKey: ["changes", projectId],
    queryFn: () => listChanges({ data: projectId ?? "" }),
    enabled: !!projectId,
  });

  if (!candidate.data) {
    if (candidate.isError) {
      return (
        <Banner
          family="danger"
          title="The Candidate did not load"
          action={
            <Button
              size="sm"
              variant="secondary"
              className="ring-current"
              onClick={() => candidate.refetch()}
            >
              Retry
            </Button>
          }
        >
          {candidate.error.message}
        </Banner>
      );
    }
    return <CandidateSkeleton label="Loading Candidate" />;
  }

  const data = candidate.data;
  const rows = checkRows(data, evidence.data ?? []);
  const labels = candidateLabels(siblings.data ?? [data]);
  const label = labels.get(data.id) ?? (data.changeSetIds.length === 0 ? "Baseline" : null);
  const riskTier = changes.data?.find((c) => c.id === data.changeId)?.riskTier;
  const others = (siblings.data ?? []).filter((c) => c.id !== data.id);
  const stale = (candidate.isError || evidence.isError) && !candidate.isFetching;

  return (
    <>
      <PageTitle
        size="detail"
        kicker={
          <span className="flex items-center gap-2">
            Candidate <StatusPill status={data.status} className="tracking-normal normal-case" />
          </span>
        }
        title={label ?? <span className="font-mono text-[0.75em] break-all">{data.id}</span>}
        meta={
          <>
            {label && <Mono>{data.id}</Mono>}
            <span>
              base <Mono>{generation(data.baseGeneration)}</Mono>
            </span>
            <span className="min-w-0 max-w-[280px]">
              <Mono truncate>{data.artifactRef ?? "fork pending"}</Mono>
            </span>
            <span>
              tree <Mono>{shortHash(data.composedTree) ?? EMPTY}</Mono>
            </span>
            <span title={data.createdAt}>created {timeAgo(data.createdAt)}</span>
            <PreviewLink candidateId={data.id} active={active} />
          </>
        }
        actions={
          others.length > 0 && (
            <Link
              to="/compare/$changeId"
              params={{ changeId: data.changeId }}
              className={cn(buttonVariants({ variant: "secondary" }), "gap-1.5")}
            >
              <Columns size={16} aria-hidden />
              Compare {formatNumber(others.length + 1)} Candidates
            </Link>
          )
        }
      />

      <Verdict candidate={data} label={label ?? "This Candidate"} rows={rows} />

      {data.selection && data.selection.winnerCandidateId !== data.id && (
        <p className="border-y border-kumo-rule py-2 text-[13px] text-pretty">
          <span className="font-semibold">Not selected.</span>{" "}
          <Link
            to="/candidates/$candidateId"
            params={{ candidateId: data.selection.winnerCandidateId }}
            className="font-semibold text-kumo-link hover:underline"
          >
            {labels.get(data.selection.winnerCandidateId) ?? data.selection.winnerCandidateId}
          </Link>{" "}
          was chosen instead: {data.selection.reason}
        </p>
      )}

      <Stats candidate={data} rows={rows} />

      {!data.acceptance && (
        <Section label="Acceptance criteria">
          <NoAcceptanceResult />
        </Section>
      )}

      {data.acceptance && data.acceptance.length > 0 && (
        <Section
          label="Acceptance criteria"
          meta={<Mono subtle>{acceptanceSummary(data.acceptance)}</Mono>}
        >
          <AcceptanceList items={data.acceptance} citations />
          <p className="text-[12px] text-kumo-subtle">
            Each criterion is judged against the composed source. Quotes are the cited lines.
          </p>
        </Section>
      )}

      <Section label="Approval and promotion">
        <CandidatePromotion
          candidate={data}
          label={label ?? "this Candidate"}
          rows={rows}
          riskTier={riskTier}
        />
      </Section>

      <Section
        label="Verification evidence"
        meta={
          <>
            {stale && (
              <>
                <StatusPill status="stale" />
                <span>updated {timeAgo(new Date(candidate.dataUpdatedAt).toISOString())}</span>
              </>
            )}
            <Mono subtle>
              {formatNumber(rows.length)} checks · {formatNumber(evidence.data?.length ?? 0)}{" "}
              records
            </Mono>
          </>
        }
      >
        {evidence.isPending ? (
          <p className="text-[13px] text-kumo-subtle">Loading Evidence…</p>
        ) : (
          <CandidateEvidence candidate={data} rows={rows} />
        )}
      </Section>

      <CandidateFilesChanged candidateId={data.id} />

      {others.length > 0 && (
        <Section
          label="Candidates of this Change"
          meta={
            <Link
              to="/compare/$changeId"
              params={{ changeId: data.changeId }}
              className="font-semibold text-kumo-link hover:underline"
            >
              Compare side by side
            </Link>
          }
        >
          <DataTable label="Candidates of this Change" minWidth={560}>
            <thead>
              <tr>
                <Th>Candidate</Th>
                <Th>Status</Th>
                <Th numeric>ChangeSets</Th>
                <Th numeric>p95</Th>
              </tr>
            </thead>
            <tbody>
              {(siblings.data ?? []).map((c) => (
                <TRow key={c.id} selected={c.id === data.id}>
                  <Td>
                    <TitleCell
                      title={
                        <RowLink to="/candidates/$candidateId" params={{ candidateId: c.id }}>
                          {labels.get(c.id) ?? c.id}
                        </RowLink>
                      }
                      meta={c.id}
                    />
                  </Td>
                  <Td>
                    <StatusPill status={c.status} />
                  </Td>
                  <Td numeric>{formatNumber(c.changeSetIds.length)}</Td>
                  <Td numeric>{formatP95(c.gate?.p95Ms)}</Td>
                </TRow>
              ))}
            </tbody>
          </DataTable>
        </Section>
      )}
    </>
  );
}

/** Verdict banner (DESIGN.md 8.5): the gate result in words, one banner per page. */
function Verdict({
  candidate,
  label,
  rows,
}: {
  candidate: CandidateDetail;
  label: string;
  rows: CheckRow[];
}) {
  const sentence = candidateSentence(label, candidate, rows);
  if (candidate.status === "promoted") {
    return (
      <Banner family="success" title="Promoted · all required checks passed with evidence">
        {sentence}
      </Banner>
    );
  }
  if (candidate.status === "verified" && candidate.gate?.promotable) {
    return (
      <Banner family="success" title="Verified · all required checks pass with evidence">
        {sentence}
        {candidate.approvalRequired &&
          !candidate.approval &&
          " A human approval is still required before promotion."}
      </Banner>
    );
  }
  if (candidate.status === "stale") {
    return (
      <Banner family="attention" title="Stale · the canonical state moved">
        {sentence} A stale Candidate cannot promote.
      </Banner>
    );
  }
  if (isActive(candidate)) {
    const recorded = rows.filter((r) => r.record).length;
    return (
      <Banner
        family="progress"
        title={
          candidate.status === "verifying" ? "Verifying in the Sandbox" : "Composing the Candidate"
        }
        progress={rows.length > 0 ? recorded / rows.length : undefined}
        action={
          rows.length > 0 ? (
            <Mono subtle>
              step {recorded} / {rows.length}
            </Mono>
          ) : undefined
        }
      >
        Checks record Evidence as they finish. Nothing counts as a pass until its Evidence lands.
      </Banner>
    );
  }
  const humanReject =
    candidate.approval?.decision === "rejected" && (candidate.gate?.promotable ?? false);
  const title = humanReject
    ? "Rejected · by a human decision"
    : `${candidate.status === "rejected" ? "Rejected" : "Not promotable"} · required checks not satisfied`;
  return (
    <Banner family="danger" title={title}>
      {sentence}
    </Banner>
  );
}

function Stats({ candidate, rows }: { candidate: CandidateDetail; rows: CheckRow[] }) {
  const tally = requiredTally(rows);
  const budget = p95Budget(candidate);
  const p95 = p95Of(candidate, rows);
  const perfRow = rows.find((r) => r.kind === "performance");
  const approval = candidate.approval;
  const approvalWord = approval
    ? approval.decision === "granted"
      ? "Approved"
      : "Rejected"
    : candidate.approvalRequired
      ? "Required"
      : "None";
  return (
    <StatStrip>
      <StatCell
        label="Required checks met"
        value={formatNumber(tally.met)}
        unit={`/ ${formatNumber(tally.total)}`}
        pill={
          tally.pending.length > 0 ? undefined : (
            <StatusPill
              status={tally.total > 0 && tally.met === tally.total ? "pass" : "fail"}
              label={tally.total > 0 && tally.met === tally.total ? "All met" : "Unmet"}
            />
          )
        }
      >
        <SegmentedSteps
          label="Required checks"
          steps={rows
            .filter((r) => r.required)
            .map((r) => ({ label: r.checkId, status: VERDICT_STATUS[r.verdict] }))}
        />
      </StatCell>
      <StatCell
        label="p95 vs budget"
        value={p95 === null ? EMPTY : formatNumber(p95, Math.abs(p95) < 10 ? 1 : 0)}
        unit={p95 === null ? undefined : "ms"}
        pill={
          perfRow && perfRow.verdict !== "pending" ? (
            <StatusPill status={VERDICT_STATUS[perfRow.verdict]} />
          ) : undefined
        }
        footnote={budget === null ? "no performance check planned" : undefined}
      >
        {budget !== null && p95 !== null && (
          <ThresholdMeter
            label="budget"
            value={p95}
            max={meterMax(budget, [p95])}
            threshold={budget}
            size="inline"
            format={(n) => formatMs(n)}
          />
        )}
        {budget !== null && p95 === null && (
          <p className="font-mono text-[11px] text-kumo-subtle">
            budget {formatMs(budget)} · no measurement yet
          </p>
        )}
      </StatCell>
      <StatCell
        label="ChangeSets composed"
        value={formatNumber(candidate.changeSetIds.length)}
        footnote={
          candidate.changeSetIds.length === 0
            ? "canonical baseline"
            : candidate.changeSetIds.join(" · ")
        }
      />
      <StatCell
        label="Approval"
        value={approvalWord}
        pill={
          approval ? (
            <StatusPill status={approval.decision === "granted" ? "approved" : "rejected"} />
          ) : candidate.approvalRequired ? (
            <StatusPill
              status={
                candidate.status === "verified" && candidate.gate?.promotable ? "waiting" : "queued"
              }
              label={
                candidate.status === "verified" && candidate.gate?.promotable
                  ? "Waiting"
                  : "After checks"
              }
            />
          ) : undefined
        }
        footnote={
          approval
            ? `${approval.policyVersion} · ${timeAgo(approval.createdAt)}`
            : `${candidate.plan?.policyVersion ?? "policy"} · ${candidate.approvalRequired ? "human gate" : "no human gate"}`
        }
      />
    </StatStrip>
  );
}
