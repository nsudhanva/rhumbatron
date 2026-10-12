import { Show, SignInButton } from "@clerk/tanstack-react-start";
import { Button } from "@cloudflare/kumo";
import { SignIn } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ChangeLink } from "../components/code/diff-files";
import { SectionError, SkeletonBar } from "../components/project/feedback";
import { DataTable, RowLink, Td, Th, TitleCell, TRow } from "../components/ui/data-table";
import { EmptyState } from "../components/ui/empty-state";
import { Mono } from "../components/ui/mono";
import { Page, PageTitle, Section } from "../components/ui/page";
import { StatusPill } from "../components/ui/status-pill";
import { shortSha } from "../components/workspace-page/model";
import {
  type CodeVersion,
  getCodeVersions,
  getProject,
  getProjectApp,
  type RollbackResult,
  rollbackProject,
} from "../lib/api";
import { EMPTY, formatNumber, generation, timeAgo } from "../lib/format";
import { can } from "../lib/permissions";
import { loadOnServer, prefetch, prefetchProjectShell } from "../lib/ssr-data";

/**
 * Versions (P16-13; AGENTS.md sections 21.3, 42.10): every Canonical Generation, an "Open" link to
 * its live bundle where the Project has an app (prod), and "Roll back to Sk". A rollback is a new
 * version whose code equals Sk's; nothing in the history is deleted. It needs an approval when the
 * Project policy gates the riskiest Change it undoes.
 */

export const Route = createFileRoute("/projects_/$projectId/versions")({
  // Server render: the version table with its "Open" links is in the first HTML.
  loader: ({ context: { queryClient }, params: { projectId } }) =>
    loadOnServer(queryClient, () =>
      Promise.all([
        prefetchProjectShell(queryClient, projectId),
        prefetch(queryClient, ["code-versions", projectId], () =>
          getCodeVersions({ data: projectId }),
        ),
        prefetch(queryClient, ["project-app", projectId], () => getProjectApp({ data: projectId })),
      ]),
    ),
  component: VersionsPage,
});

const LINK = "relative z-10 text-kumo-link underline-offset-2 hover:underline";

function VersionsPage() {
  return (
    <>
      <Show when="signed-in">
        <VersionsContent />
      </Show>
      <Show when="signed-out">
        <Page>
          <PageTitle kicker="Project" title="Versions" />
          <EmptyState
            what="Sign in to see this Project's versions."
            how="Versions are visible to members of the project's organization."
            action={
              <SignInButton>
                <Button variant="primary" icon={SignIn}>
                  Sign in
                </Button>
              </SignInButton>
            }
          />
        </Page>
      </Show>
    </>
  );
}

function VersionsContent() {
  const { projectId } = Route.useParams();
  const queryClient = useQueryClient();
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject({ data: projectId }),
  });
  const versions = useQuery({
    queryKey: ["code-versions", projectId],
    queryFn: () => getCodeVersions({ data: projectId }),
  });
  const app = useQuery({
    queryKey: ["project-app", projectId],
    queryFn: () => getProjectApp({ data: projectId }),
  });
  const [confirming, setConfirming] = useState<number | null>(null);
  const [result, setResult] = useState<RollbackResult | null>(null);
  const live = versions.data?.liveGeneration;
  const rollback = useMutation({
    mutationFn: (target: number) =>
      rollbackProject({
        data: { projectId, targetGeneration: target, expectedGeneration: live ?? 0 },
      }),
    onSuccess: (outcome) => {
      setResult(outcome);
      setConfirming(null);
      for (const key of ["code-versions", "project-app", "project", "changes"]) {
        void queryClient.invalidateQueries({ queryKey: [key, projectId] });
      }
    },
  });
  const links = new Map((app.data?.versions ?? []).map((v) => [v.generation, v.url]));
  const liveTree = versions.data?.versions.find((v) => v.live)?.treeSha;

  return (
    <Page>
      <PageTitle
        kicker={project.data?.name ?? "Project"}
        title="Versions"
        meta={
          live !== undefined && (
            <>
              <span>
                live <Mono>{generation(live)}</Mono>
              </span>
              {app.data?.app && app.data.app.status !== "removed" && (
                <a href={app.data.app.url} target="_blank" rel="noreferrer" className={LINK}>
                  Open app
                </a>
              )}
            </>
          )
        }
      />
      {result && <Outcome result={result} />}
      {rollback.isError && (
        <p className="text-[13px] text-kumo-danger" role="alert">
          The rollback did not run. {rollback.error.message}
        </p>
      )}
      <Section
        label="History"
        meta={
          versions.data && (
            <Mono subtle>
              {formatNumber(versions.data.versions.length)}
              {versions.data.truncated ? "+" : ""} versions · a rollback adds a version, never
              deletes one
            </Mono>
          )
        }
      >
        {versions.isError ? (
          <SectionError
            message={`Versions could not load. ${versions.error.message}`}
            onRetry={() => versions.refetch()}
          />
        ) : !versions.data ? (
          <div className="grid gap-2" aria-busy>
            <SkeletonBar height={13} className="w-1/2" />
            <SkeletonBar height={13} className="w-3/4" />
          </div>
        ) : versions.data.versions.length === 0 ? (
          <EmptyState what="No versions yet." how="Seed the source on the project overview." />
        ) : (
          <DataTable label="Versions" minWidth={820}>
            <thead>
              <tr>
                <Th>Version</Th>
                <Th>Change</Th>
                <Th>App</Th>
                <Th>Rollback</Th>
                <Th numeric>When</Th>
              </tr>
            </thead>
            <tbody>
              {versions.data.versions.map((v) => (
                <VersionRow
                  key={v.generation}
                  projectId={projectId}
                  version={v}
                  openUrl={links.get(v.generation) ?? null}
                  canRollBack={
                    can(project.data?.role, "app.rollback") &&
                    live !== undefined &&
                    v.generation < live &&
                    !!v.treeSha &&
                    v.treeSha !== liveTree
                  }
                  confirming={confirming === v.generation}
                  pending={rollback.isPending && rollback.variables === v.generation}
                  busy={rollback.isPending}
                  onAsk={() => {
                    setResult(null);
                    setConfirming(v.generation);
                  }}
                  onCancel={() => setConfirming(null)}
                  onConfirm={() => rollback.mutate(v.generation)}
                  nextGeneration={live === undefined ? null : live + 1}
                />
              ))}
            </tbody>
          </DataTable>
        )}
      </Section>
    </Page>
  );
}

function VersionRow({
  projectId,
  version: v,
  openUrl,
  canRollBack,
  confirming,
  pending,
  busy,
  onAsk,
  onCancel,
  onConfirm,
  nextGeneration,
}: {
  projectId: string;
  version: CodeVersion;
  openUrl: string | null;
  canRollBack: boolean;
  confirming: boolean;
  pending: boolean;
  busy: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  nextGeneration: number | null;
}) {
  return (
    <TRow>
      <Td>
        <TitleCell
          title={
            v.treeSha ? (
              <RowLink
                to="/projects/$projectId/code"
                params={{ projectId }}
                search={v.live ? {} : { tree: v.treeSha }}
              >
                <span className="inline-flex items-center gap-2">
                  {generation(v.generation)}
                  {v.live && <StatusPill status="live" />}
                </span>
              </RowLink>
            ) : (
              generation(v.generation)
            )
          }
          meta={v.commit ? shortSha(v.commit) : EMPTY}
        />
      </Td>
      <Td className="max-w-[340px]">
        <span className="relative z-10 block truncate">
          {v.change ? (
            <ChangeLink change={v.change} />
          ) : (
            <span className="text-kumo-subtle">Initial source</span>
          )}
        </span>
      </Td>
      <Td>
        {openUrl ? (
          <a href={openUrl} target="_blank" rel="noreferrer" className={LINK}>
            Open
          </a>
        ) : (
          <span className="text-kumo-subtle">{EMPTY}</span>
        )}
      </Td>
      <Td className="text-[13px]">
        {/* While a rollback runs, only the clicked row shows its progress; the rest hide. */}
        {!canRollBack || (busy && !pending) ? (
          <span className="text-kumo-subtle">{EMPTY}</span>
        ) : pending ? (
          <span role="status" className="relative z-10">
            Rolling back to {generation(v.generation)}…
          </span>
        ) : confirming ? (
          <span className="relative z-10 flex flex-wrap items-center gap-x-3">
            <span>
              Ship {generation(v.generation)}'s code as{" "}
              {nextGeneration === null ? "a new version" : generation(nextGeneration)}?
            </span>
            <button type="button" className={LINK} onClick={onConfirm}>
              Roll back
            </button>
            <button type="button" className={LINK} onClick={onCancel}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" className={LINK} onClick={onAsk}>
            Roll back to {generation(v.generation)}
          </button>
        )}
      </Td>
      <Td numeric>
        {v.at ? (
          <time dateTime={v.at} title={v.at}>
            {timeAgo(v.at)}
          </time>
        ) : (
          EMPTY
        )}
      </Td>
    </TRow>
  );
}

function Outcome({ result }: { result: RollbackResult }) {
  const candidate = (
    <Link
      to="/candidates/$candidateId"
      params={{ candidateId: result.candidateId }}
      className="text-kumo-link underline-offset-2 hover:underline"
    >
      Open the rollback Candidate
    </Link>
  );
  return (
    <p className="text-[13px]" role="status">
      {result.status === "promoted" ? (
        <>
          {generation(result.generation)} is canonical with the code of{" "}
          {generation(result.targetGeneration)}. The app moves to it after its smoke check.{" "}
          {candidate}
        </>
      ) : (
        <>
          Rolling back to {generation(result.targetGeneration)} needs an approval by policy. Approve
          it, then promote it. {candidate}
        </>
      )}
    </p>
  );
}
