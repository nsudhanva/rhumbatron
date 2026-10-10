import { Show, useUser } from "@clerk/tanstack-react-start";
import { Button, buttonVariants, cn } from "@cloudflare/kumo";
import { CheckCircle, Columns, WarningCircle, XCircle } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Banner } from "../components/candidate/banner";
import {
  type CheckRow,
  candidateLabels,
  checkRows,
  formatP95,
  isActive,
  p95Budget,
  p95Of,
  releaseInFlight,
  requiredTally,
  versionSentence,
  versionWord,
} from "../components/candidate/model";
import { CandidateSkeleton } from "../components/candidate/skeleton";
import { TechnicalDetails } from "../components/candidate/technical-details";
import { CandidateEvidence } from "../components/candidate-evidence";
import { CandidatePromotion } from "../components/candidate-promotion";
import { EmptyState } from "../components/ui/empty-state";
import { KeyValue } from "../components/ui/key-value";
import { Loader } from "../components/ui/loader";
import { Page, PageTitle, Section } from "../components/ui/page";
import { StatusPill } from "../components/ui/status-pill";
import { Term } from "../components/ui/term";
import {
  type ApprovalWithName,
  type CandidateDetail,
  getCandidate,
  listCandidateEvidence,
  listCandidates,
  listChanges,
} from "../lib/api";
import { EMPTY, formatMs, formatNumber, generation, generationCode, timeAgo } from "../lib/format";

export const Route = createFileRoute("/candidates/$candidateId")({ component: CandidatePage });

/** Checks run for minutes; poll while they are active, then stop (AGENTS.md section 39). */
const POLL_MS = 10_000;

function CandidatePage() {
  return (
    <Page>
      <Show when="signed-in">
        <CandidateView />
      </Show>
      <Show when="signed-out">
        <EmptyState
          what="Sign in to view this version."
          how="Versions belong to a project you are a member of."
        />
      </Show>
    </Page>
  );
}

function CandidateView() {
  const { candidateId } = Route.useParams();
  const candidate = useQuery({
    queryKey: ["candidate", candidateId],
    queryFn: () => getCandidate({ data: candidateId }),
    refetchInterval: (query) =>
      !query.state.data || isActive(query.state.data) || releaseInFlight(query.state.data)
        ? POLL_MS
        : false,
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
  // Risk tier is only on the Change summary list; it names the rule behind the approval.
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
          title="This version did not load"
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
    return <CandidateSkeleton label="Loading this version" />;
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
        title={label ?? <span className="font-mono text-[0.75em] break-all">{data.id}</span>}
        meta={
          <>
            <span>
              <Term k="basedOn" plain /> {generation(data.baseGeneration)}
            </span>
            <span aria-hidden>·</span>
            <span title={data.createdAt}>created {timeAgo(data.createdAt)}</span>
            <span aria-hidden>·</span>
            <span>{versionWord(data.status)}</span>
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
              Compare versions
            </Link>
          )
        }
      />

      <div className="grid gap-3">
        <StatusHeader candidate={data} rows={rows} />
        <SummaryLine candidate={data} rows={rows} />
        <TechnicalDetails>
          <KeyValue
            items={[
              { label: "Candidate", value: data.id, mono: true },
              { label: "Status", value: data.status, mono: true },
              { label: "Base", value: generationCode(data.baseGeneration), mono: true },
              { label: "Artifact", value: data.artifactRef, mono: true },
              { label: "Composed tree", value: data.composedTree, mono: true },
              { label: "Composed commit", value: data.composedCommit, mono: true },
              {
                label: "ChangeSets",
                value: data.changeSetIds.length > 0 ? data.changeSetIds.join(" · ") : null,
                mono: true,
              },
              { label: "Status reason", value: data.statusReason },
            ]}
          />
        </TechnicalDetails>
      </div>

      <Section
        label={<Term k="checks" />}
        meta={
          <>
            {stale && (
              <span>
                Couldn't refresh · updated{" "}
                {timeAgo(new Date(candidate.dataUpdatedAt).toISOString())}
              </span>
            )}
            <span>{formatNumber(rows.length)} checks</span>
          </>
        }
      >
        {evidence.isPending ? (
          <p className="flex items-center gap-2 text-[14px] text-kumo-subtle">
            <Loader size={16} /> Loading checks…
          </p>
        ) : (
          <CandidateEvidence candidate={data} rows={rows} />
        )}
      </Section>

      <Section label="Your approval and shipping">
        <CandidatePromotion
          candidate={data}
          label={label ?? "this version"}
          rows={rows}
          riskTier={riskTier}
        />
      </Section>

      {others.length > 0 && (
        <Section
          label="Other versions of this change"
          meta={
            <Link
              to="/compare/$changeId"
              params={{ changeId: data.changeId }}
              className="font-semibold text-kumo-link hover:underline"
            >
              Compare versions
            </Link>
          }
        >
          <ul className="grid rounded-lg border border-kumo-rule bg-kumo-elevated">
            {others.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-kumo-rule px-3 py-2.5 text-[14px] last:border-b-0"
              >
                <Link
                  to="/candidates/$candidateId"
                  params={{ candidateId: c.id }}
                  className="font-semibold text-kumo-link hover:underline"
                >
                  {labels.get(c.id) ?? c.id}
                </Link>
                <StatusPill status={c.status} label={versionWord(c.status)} />
                <span className="text-[13px] text-kumo-subtle">
                  Response time (p95) {formatP95(c.gate?.p95Ms)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

/** One status header (spec 6.2 P1): icon, one word, one sentence. */
function StatusHeader({ candidate, rows }: { candidate: CandidateDetail; rows: CheckRow[] }) {
  const word = versionWord(candidate.status);
  let sentence = versionSentence(candidate, rows);
  const awaiting =
    candidate.status === "verified" &&
    candidate.gate?.promotable &&
    candidate.approvalRequired &&
    !candidate.approval;
  if (awaiting) sentence += " A person must approve it before it ships.";
  const icon = { size: 20, className: "mt-px shrink-0", "aria-hidden": true } as const;
  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-lg border border-kumo-rule bg-kumo-elevated px-4 py-3 text-[14px]"
    >
      {isActive(candidate) ? (
        <Loader size={20} label={word} className="mt-px shrink-0" />
      ) : candidate.status === "rejected" ? (
        <XCircle {...icon} className={cn(icon.className, "text-kumo-danger")} />
      ) : candidate.status === "stale" ? (
        <WarningCircle {...icon} className={cn(icon.className, "text-kumo-warning")} />
      ) : (
        <CheckCircle {...icon} className={cn(icon.className, "text-kumo-success")} />
      )}
      <p className="text-pretty">
        <span className="font-semibold">{word}</span>
        <span className="text-kumo-subtle"> · </span>
        {sentence}
      </p>
    </div>
  );
}
StatusHeader.displayName = "StatusHeader";

/** Required checks, response time and approval, in one line (replaces the stat strip). */
function SummaryLine({ candidate, rows }: { candidate: CandidateDetail; rows: CheckRow[] }) {
  const { user } = useUser();
  const tally = requiredTally(rows);
  const budget = p95Budget(candidate);
  const p95 = p95Of(candidate, rows);
  const { approval } = candidate;
  const approver = approval
    ? approval.approverUserId === (user ? `usr_${user.id}` : null)
      ? "you"
      : ((approval as ApprovalWithName).approverName ?? "a person")
    : null;
  const approvalText = approval
    ? `${approval.decision === "granted" ? "Approved" : "Rejected"} by ${approver} ${timeAgo(approval.createdAt)}`
    : candidate.approvalRequired
      ? "Required"
      : "Not needed";
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-kumo-subtle">
      <span>
        Required checks:{" "}
        <span className="text-kumo-default">
          {formatNumber(tally.met)} of {formatNumber(tally.total)} passed
        </span>
      </span>
      {(p95 !== null || budget !== null) && (
        <>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1">
            <Term k="p95" />{" "}
            <span
              className={cn(
                "text-kumo-default",
                p95 !== null && budget !== null && p95 >= budget && "text-kumo-danger",
              )}
            >
              {p95 === null ? EMPTY : formatP95(p95)}
            </span>
            {budget !== null && <span>(limit {formatMs(budget)})</span>}
          </span>
        </>
      )}
      <span aria-hidden>·</span>
      <span>
        Approval: <span className="text-kumo-default">{approvalText}</span>
      </span>
    </p>
  );
}
SummaryLine.displayName = "SummaryLine";
