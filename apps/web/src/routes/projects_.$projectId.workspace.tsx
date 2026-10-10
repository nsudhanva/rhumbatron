import { Show, SignInButton } from "@clerk/tanstack-react-start";
import { Button, buttonVariants, cn } from "@cloudflare/kumo";
import { SignIn } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { SectionError, SkeletonBar } from "../components/project/feedback";
import { EmptyState } from "../components/ui/empty-state";
import { KeyValue } from "../components/ui/key-value";
import { Mono } from "../components/ui/mono";
import { Page, PageTitle, Section, TwoUp } from "../components/ui/page";
import { StatCell, StatStrip } from "../components/ui/stat-strip";
import { FileBrowser } from "../components/workspace-page/file-browser";
import { ForkInspector } from "../components/workspace-page/fork-inspector";
import { ForkTree } from "../components/workspace-page/fork-tree";
import {
  changesWithForks,
  type ForkRow,
  forkRows,
  isWorkspaceActive,
  parseArtifactRef,
  shortSha,
} from "../components/workspace-page/model";
import { getProject, getWorkspace, getWorkspaceFiles, type WorkspaceView } from "../lib/api";
import { EMPTY, formatAge, formatNumber, generation, truncate } from "../lib/format";

export const Route = createFileRoute("/projects_/$projectId/workspace")({
  component: WorkspacePage,
});

/** Forks change while Tasks run and Candidates verify; poll then, and stop when idle. */
const POLL_MS = 10_000;
/** Must match CHANGE_LIMIT in workers/api/src/workspace.ts. */
const CHANGE_LIMIT = 10;
const ALL = "all";

function WorkspacePage() {
  return (
    <>
      <Show when="signed-in">
        <WorkspaceContent />
      </Show>
      <Show when="signed-out">
        <Page>
          <PageTitle kicker="Project" title="Workspace" />
          <EmptyState
            what="Sign in to view this workspace."
            how="Workspaces are visible to members of the project's organization."
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

function WorkspaceContent() {
  const { projectId } = Route.useParams();
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject({ data: projectId }),
  });
  const view = useQuery({
    queryKey: ["workspace", projectId],
    queryFn: () => getWorkspace({ data: projectId }),
    refetchInterval: (query) => (isWorkspaceActive(query.state.data) ? POLL_MS : false),
  });
  const canonical = view.data?.canonical;
  const tree = canonical?.assigned ? canonical.treeSha : undefined;
  // A tree's file index never changes, so it is fetched once per tree.
  const files = useQuery({
    queryKey: ["workspace-files", projectId, tree],
    queryFn: () => getWorkspaceFiles({ data: { projectId, ...(tree ? { tree } : {}) } }),
    enabled: !!tree,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const commit = files.data?.commit ?? null;

  return (
    <Page>
      <PageTitle
        kicker={project.data?.name ?? "Project"}
        title="Workspace"
        meta={
          canonical && (
            <>
              <Mono subtle>{generation(canonical.generation)}</Mono>
              <span aria-hidden>·</span>
              {canonical.assigned ? (
                <Mono subtle truncate className="max-w-[48ch]">
                  {canonical.artifactRef}
                </Mono>
              ) : (
                <span>No source yet</span>
              )}
            </>
          )
        }
      />

      {view.isError && (
        <SectionError
          message={`The workspace could not load. ${view.error.message}`}
          onRetry={() => view.refetch()}
          retrying={view.isFetching}
        />
      )}

      <WorkspaceStats
        view={view.data}
        fileCount={files.data?.indexed ? files.data.files.length : undefined}
        fileTruncated={files.data?.truncated ?? false}
        commit={commit}
      />

      {view.data && !view.data.canonical.assigned ? (
        <Section label="Canonical Artifact">
          <EmptyState
            what="No canonical source yet."
            how="Seed the source on the project overview. Forks appear once Tasks edit it."
            action={
              <Link
                to="/projects/$projectId"
                params={{ projectId }}
                className={buttonVariants({ variant: "secondary" })}
              >
                Open overview
              </Link>
            }
          />
        </Section>
      ) : (
        <>
          <Forks view={view.data} commit={commit} />
          <TwoUp>
            <Section label="Canonical Artifact">
              {view.data ? (
                <CanonicalFacts view={view.data} commit={commit} commitPending={files.isPending} />
              ) : (
                <div className="grid gap-2">
                  <SkeletonBar height={12} className="w-3/4" />
                  <SkeletonBar height={12} className="w-1/2" />
                  <SkeletonBar height={12} className="w-2/3" />
                </div>
              )}
            </Section>
            <Section
              label="Canonical files"
              meta={
                files.data?.indexed && (
                  <Mono subtle>
                    {formatNumber(files.data.files.length)}
                    {files.data.truncated ? "+" : ""} files
                  </Mono>
                )
              }
            >
              {files.isError ? (
                <SectionError
                  message={`The file index could not load. ${files.error.message}`}
                  onRetry={() => files.refetch()}
                  retrying={files.isFetching}
                />
              ) : files.data ? (
                <>
                  <FileBrowser key={files.data.treeSha} index={files.data} />
                  <p className="text-[11px] text-kumo-subtle">
                    Paths from the file index of tree {shortSha(files.data.treeSha, 12)}. The index
                    stores paths only, so sizes and file contents are not shown.
                    {files.data.truncated && " The index stops at 2,000 paths."}
                  </p>
                </>
              ) : (
                <div className="grid gap-2">
                  <SkeletonBar height={12} className="w-2/3" />
                  <SkeletonBar height={12} className="w-1/2" />
                  <SkeletonBar height={12} className="w-3/5" />
                </div>
              )}
            </Section>
          </TwoUp>
        </>
      )}
    </Page>
  );
}

function WorkspaceStats({
  view,
  fileCount,
  fileTruncated,
  commit,
}: {
  view: WorkspaceView | undefined;
  fileCount: number | undefined;
  fileTruncated: boolean;
  commit: string | null;
}) {
  const loading = <SkeletonBar height={34} width={96} />;
  const published = view?.workspaces.filter((w) => w.changeSet).length ?? 0;
  const running = view?.workspaces.filter((w) => w.runStatus === "running").length ?? 0;
  const verified =
    view?.candidates.filter((c) => c.status === "verified" || c.status === "promoted").length ?? 0;
  const scope = view?.truncated ? `latest ${CHANGE_LIMIT} changes` : "all changes";
  return (
    <StatStrip>
      <StatCell
        label="Canonical generation"
        value={view ? generation(view.canonical.generation) : loading}
        footnote={view?.canonical.assigned ? `tree ${shortSha(view.canonical.treeSha, 10)}` : EMPTY}
      />
      <StatCell
        label="Task forks"
        value={view ? formatNumber(view.workspaces.length) : loading}
        footnote={
          view
            ? `${formatNumber(published)} with ChangeSets${running ? ` · ${formatNumber(running)} running` : ""}`
            : EMPTY
        }
      />
      <StatCell
        label="Candidate forks"
        value={view ? formatNumber(view.candidates.length) : loading}
        footnote={view ? `${formatNumber(verified)} verified or promoted · ${scope}` : EMPTY}
      />
      <StatCell
        label="Canonical files"
        value={
          fileCount !== undefined
            ? `${formatNumber(fileCount)}${fileTruncated ? "+" : ""}`
            : view && !view.canonical.assigned
              ? EMPTY
              : loading
        }
        footnote={commit ? `commit ${shortSha(commit, 10)}` : EMPTY}
      />
    </StatStrip>
  );
}

function CanonicalFacts({
  view,
  commit,
  commitPending,
}: {
  view: WorkspaceView;
  commit: string | null;
  commitPending: boolean;
}) {
  const { canonical } = view;
  const ref = parseArtifactRef(canonical.artifactRef);
  return (
    <KeyValue
      items={[
        { label: "Generation", value: generation(canonical.generation), mono: true },
        { label: "Artifact", value: canonical.artifactRef, mono: true },
        { label: "Repo", value: ref.repo, mono: true },
        { label: "Branch", value: ref.ref, mono: true },
        {
          label: "Commit",
          value: commit ?? (commitPending ? "Loading" : null),
          mono: true,
        },
        { label: "Tree", value: canonical.treeSha, mono: true },
        {
          label: "Last promotion",
          value: canonical.lastPromotedCandidateId ? (
            <Link
              to="/candidates/$candidateId"
              params={{ candidateId: canonical.lastPromotedCandidateId }}
              className="text-kumo-link hover:underline"
            >
              {canonical.lastPromotedCandidateId}
            </Link>
          ) : null,
          mono: true,
        },
        {
          label: "Updated",
          value: canonical.updatedAt ? (
            <time dateTime={canonical.updatedAt} title={canonical.updatedAt}>
              {formatAge(canonical.updatedAt)}
            </time>
          ) : null,
        },
        // No build record is stored yet (AGENTS.md 38.5 lists build state); shown as unknown.
        { label: "Build", value: null },
      ]}
    />
  );
}

/** Change filter, fork tree and the selected fork's detail. */
function Forks({ view, commit }: { view: WorkspaceView | undefined; commit: string | null }) {
  const changes = useMemo(() => (view ? changesWithForks(view) : []), [view]);
  const [changeFilter, setChangeFilter] = useState<string | null>(null);
  // Default to the newest Change that has forks; fall back to every loaded Change.
  const scope = changeFilter ?? changes[0]?.id ?? ALL;
  const rows = useMemo(
    () => (view ? forkRows(view, scope === ALL ? null : scope) : []),
    [view, scope],
  );
  const rowsByKey = useMemo(() => {
    const all = view ? forkRows(view, null) : [];
    return new Map(all.map((r) => [r.key, r] as const));
  }, [view]);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRow: ForkRow | undefined =
    (selected ? rows.find((r) => r.key === selected) : undefined) ??
    rows.find((r) => r.kind === "workspace" && r.fork.changeSet) ??
    rows[0];

  const total = (view?.workspaces.length ?? 0) + (view?.candidates.length ?? 0);

  return (
    <Section
      label="Forks"
      meta={view ? <Mono subtle>{formatNumber(rows.length)} shown</Mono> : null}
    >
      {!view ? (
        <div className="grid gap-2" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <SkeletonBar key={i} height={13} className={i === 0 ? "w-1/2" : "w-full"} />
          ))}
        </div>
      ) : total === 0 ? (
        <EmptyState
          what="No forks yet."
          how="A Task fork appears when an implementer starts editing source; a Candidate fork when ChangeSets are composed."
        />
      ) : (
        <>
          {changes.length > 1 && (
            <ChangeChips
              changes={changes}
              scope={scope}
              total={total}
              onChange={(id) => {
                setChangeFilter(id);
                setSelected(null);
              }}
            />
          )}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] items-start gap-7">
            <div className="grid min-w-0 gap-2">
              <ForkTree
                root={{
                  name: parseArtifactRef(view.canonical.artifactRef).repo,
                  generation: view.canonical.generation,
                  hash: commit ?? view.canonical.treeSha,
                }}
                rows={rows}
                selectedKey={selectedRow?.key ?? null}
                onSelect={setSelected}
              />
              <p className="text-[11px] text-kumo-subtle">
                Task and Candidate forks both start from the canonical Artifact at their base
                generation. A Candidate fork merges the ChangeSets it composes.
              </p>
            </div>
            <div className="grid min-w-0 content-start gap-3">
              <ForkInspector
                row={selectedRow}
                rowsByKey={rowsByKey}
                onSelect={(key) => {
                  if (!rows.some((r) => r.key === key)) {
                    const target = rowsByKey.get(key);
                    if (target) setChangeFilter(target.fork.changeId);
                  }
                  setSelected(key);
                }}
              />
            </div>
          </div>
        </>
      )}
    </Section>
  );
}

/** Filter chips (DESIGN.md 8.3): one per Change with forks, plus All; selected in ink. */
function ChangeChips({
  changes,
  scope,
  total,
  onChange,
}: {
  changes: ReturnType<typeof changesWithForks>;
  scope: string;
  total: number;
  onChange: (id: string) => void;
}) {
  const chips = [
    ...changes.map((c) => ({
      id: c.id,
      label: truncate(c.goal, 36),
      title: c.goal,
      count: c.forks,
    })),
    { id: ALL, label: "All changes", title: "Every loaded Change", count: total },
  ];
  return (
    <fieldset className="flex flex-wrap gap-2">
      <legend className="sr-only">Change</legend>
      {chips.map((chip) => {
        const selected = chip.id === scope;
        return (
          <button
            key={chip.id}
            type="button"
            title={chip.title}
            aria-pressed={selected}
            onClick={() => onChange(chip.id)}
            className={cn(
              "flex cursor-pointer items-center gap-2 border border-kumo-rule px-2.5 py-1 text-[12px] transition-colors duration-(--rh-dur-ui) pointer-coarse:min-h-11",
              selected ? "border-kumo-ink bg-kumo-ink text-kumo-inverse" : "hover:bg-kumo-tint",
            )}
          >
            <span className="max-w-[36ch] truncate">{chip.label}</span>
            <span className="font-mono opacity-70 tabular-nums">{formatNumber(chip.count)}</span>
          </button>
        );
      })}
    </fieldset>
  );
}
