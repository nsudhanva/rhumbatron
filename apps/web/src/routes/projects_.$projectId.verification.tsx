import { Show } from "@clerk/tanstack-react-start";
import { Button, buttonVariants } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Banner } from "../components/candidate/banner";
import { isActive } from "../components/candidate/model";
import { CandidateSkeleton } from "../components/candidate/skeleton";
import { TechnicalDetails } from "../components/candidate/technical-details";
import { EmptyState } from "../components/ui/empty-state";
import { Page, PageTitle, Section } from "../components/ui/page";
import { Term } from "../components/ui/term";
import { CandidateTable } from "../components/verification-page/candidate-table";
import { HeatGrid } from "../components/verification-page/heat-grid";
import {
  buildModel,
  GRID_COLUMNS,
  kindsOf,
  type Stage,
  stagesOf,
  stats,
} from "../components/verification-page/model";
import { PipelineStrip, type StageCount } from "../components/verification-page/pipeline-strip";
import { getProjectVerification } from "../lib/api";
import { formatNumber, timeAgo } from "../lib/format";
import { useViewMode } from "../lib/view-mode";

/**
 * All checks (Advanced; AGENTS.md sections 34, 35, 38): how recent versions fared against their
 * required checks. Every verdict uses the version model's gate rules, so a check without a
 * `checked_supported` pass is "Not run" and never counts as passed.
 */
export const Route = createFileRoute("/projects_/$projectId/verification")({
  component: VerificationPage,
});

const POLL_MS = 10_000;

const STAGE_NAMES: Record<Stage, string> = {
  composing: "Assembling",
  verifying: "Checking",
  verified: "Passed",
  rejected: "Set aside",
  promoted: "Shipped",
};

const TITLE = <Term k="checks">All checks</Term>;
const INTRO = "Every version of every change, against its required checks.";

function VerificationPage() {
  return (
    <Page>
      <Show when="signed-in">
        <VerificationView />
      </Show>
      <Show when="signed-out">
        <PageTitle title={TITLE} meta={INTRO} />
        <EmptyState
          what="Sign in to view checks."
          how="Versions and their check results are visible to members of the project."
        />
      </Show>
    </Page>
  );
}

/** "12 recent versions: 9 passed, 2 set aside, 1 checking." */
function summarySentence(s: ReturnType<typeof stats>) {
  const parts = [
    s.passed > 0 && `${formatNumber(s.passed)} passed`,
    s.setAside > 0 && `${formatNumber(s.setAside)} set aside`,
    s.outOfDate > 0 && `${formatNumber(s.outOfDate)} out of date`,
    s.checking > 0 && `${formatNumber(s.checking)} checking`,
  ].filter(Boolean);
  const head = `${formatNumber(s.total)} recent ${s.total === 1 ? "version" : "versions"}`;
  return parts.length > 0 ? `${head}: ${parts.join(", ")}.` : `${head}.`;
}

function VerificationView() {
  const { projectId } = Route.useParams();
  const view = useViewMode();
  const [stage, setStage] = useState<Stage | null>(null);
  const verification = useQuery({
    queryKey: ["project-verification", projectId],
    queryFn: () => getProjectVerification({ data: projectId }),
    refetchInterval: (query) =>
      !query.state.data || query.state.data.candidates.some(isActive) ? POLL_MS : false,
  });

  const data = verification.data;
  const items = useMemo(() => (data ? buildModel(data) : []), [data]);
  const summary = useMemo(() => stats(items), [items]);
  const kinds = useMemo(() => kindsOf(items.filter((i) => i.gridIndex !== null)), [items]);

  const title = (
    <PageTitle
      title={TITLE}
      meta={
        <>
          <span>{INTRO}</span>
          {items.length > 0 && <span>{summarySentence(summary)}</span>}
        </>
      }
      actions={
        <Link
          to="/projects/$projectId"
          params={{ projectId }}
          className={buttonVariants({ variant: "secondary" })}
        >
          Open the project
        </Link>
      }
    />
  );

  if (!data) {
    if (verification.isError) {
      return (
        <>
          {title}
          <Banner
            family="danger"
            title="Checks did not load"
            action={
              <Button
                size="sm"
                variant="secondary"
                className="ring-current"
                onClick={() => verification.refetch()}
              >
                Retry
              </Button>
            }
          >
            {verification.error.message}
          </Banner>
        </>
      );
    }
    return <CandidateSkeleton label="Loading checks" rows={8} />;
  }

  if (items.length === 0) {
    return (
      <>
        {title}
        <EmptyState
          what="No version has been checked in this project yet."
          how="A version appears when a change finishes its tasks and its checks start."
          action={
            <Link
              to="/projects/$projectId"
              params={{ projectId }}
              className={buttonVariants({ variant: "secondary" })}
            >
              Open the project
            </Link>
          }
        />
      </>
    );
  }

  const reached = (s: Stage) => items.filter((i) => stagesOf(i.candidate).has(s)).length;
  const now = (status: string[]) => items.filter((i) => status.includes(i.candidate.status)).length;
  const stages: StageCount[] = [
    {
      stage: "composing",
      name: STAGE_NAMES.composing,
      count: reached("composing"),
      description: `${formatNumber(now(["composing", "composed"]))} assembling now`,
    },
    {
      stage: "verifying",
      name: STAGE_NAMES.verifying,
      count: reached("verifying"),
      description: `${formatNumber(now(["verifying"]))} being checked now`,
    },
    {
      stage: "verified",
      name: STAGE_NAMES.verified,
      count: reached("verified"),
      description: "passed every required check",
    },
    {
      stage: "rejected",
      name: STAGE_NAMES.rejected,
      count: reached("rejected"),
      description: "failed a check or was rejected",
    },
    {
      stage: "promoted",
      name: STAGE_NAMES.promoted,
      count: reached("promoted"),
      description: "became a release",
    },
  ];

  const filtered = stage ? items.filter((i) => stagesOf(i.candidate).has(stage)) : items;
  const stale = verification.isError;

  return (
    <>
      {title}
      {data.evidenceTruncated && (
        <Banner family="attention" title="Some check results are not shown">
          This page reads at most 1,000 check results. Checks without a loaded result show as "Not
          run" here; open a version to see all of its results.
        </Banner>
      )}

      <Section
        label="Recent versions"
        meta={
          <>
            {stale && (
              <span>
                Couldn't refresh · updated{" "}
                {timeAgo(new Date(verification.dataUpdatedAt).toISOString())}
              </span>
            )}
            {stage && (
              <Button size="sm" variant="ghost" onClick={() => setStage(null)}>
                Show all
              </Button>
            )}
            <span>
              {stage
                ? `${formatNumber(filtered.length)} of ${formatNumber(items.length)} · ${STAGE_NAMES[stage].toLowerCase()}`
                : `Last ${formatNumber(items.length)}`}
            </span>
          </>
        }
      >
        {filtered.length === 0 ? (
          <EmptyState
            what={`No recent version reached "${STAGE_NAMES[stage ?? "composing"]}".`}
            how="Choose another stage, or show all versions."
            action={
              <Button size="sm" variant="secondary" onClick={() => setStage(null)}>
                Show all
              </Button>
            }
          />
        ) : (
          <CandidateTable items={filtered} />
        )}
      </Section>

      {/* The stage strip and heat grid are developer views: closed unless Systems view is on. */}
      <TechnicalDetails
        key={view}
        open={view === "systems"}
        label="Technical details: stages and check grid"
        className="text-[13px]"
      >
        <div className="grid gap-7">
          <Section label="Stages" as="h3" meta={<span>Versions that reached each stage</span>}>
            <PipelineStrip stages={stages} selected={stage} onSelect={setStage} />
            {summary.outOfDate > 0 && (
              <p className="text-[12px] text-kumo-subtle">
                {formatNumber(summary.outOfDate)} out-of-date{" "}
                {summary.outOfDate === 1 ? "version stops" : "versions stop"} at checking: another
                change shipped first, so they must be rebuilt.
              </p>
            )}
          </Section>
          <Section
            label="Check results by version"
            as="h3"
            meta={
              <span>
                {formatNumber(kinds.length)} checks ×{" "}
                {formatNumber(Math.min(items.length, GRID_COLUMNS))} versions
              </span>
            }
          >
            {kinds.length === 0 ? (
              <EmptyState
                what="No checks have been planned yet."
                how="Rows appear once a version is assembled and its checks are planned."
              />
            ) : (
              <HeatGrid items={items} kinds={kinds} />
            )}
            <p className="text-[12px] text-kumo-subtle">
              Columns are the {formatNumber(GRID_COLUMNS)} most recent versions, oldest on the left.
              A pass needs a recorded result; a check that did not run, was skipped or timed out is
              "Not run".
            </p>
          </Section>
        </div>
      </TechnicalDetails>
    </>
  );
}
