import { Show, SignInButton } from "@clerk/tanstack-react-start";
import { Button, buttonVariants, cn } from "@cloudflare/kumo";
import { SignIn } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { SectionError, SkeletonBar } from "../components/project/feedback";
import { EmptyState } from "../components/ui/empty-state";
import { KeyValue } from "../components/ui/key-value";
import { Mono } from "../components/ui/mono";
import { Page, PageTitle, Section } from "../components/ui/page";
import { StatusPill } from "../components/ui/status-pill";
import { Term } from "../components/ui/term";
import { FileBrowser } from "../components/workspace-page/file-browser";
import { ForkInspector } from "../components/workspace-page/fork-inspector";
import { AddsDels, ForkTree } from "../components/workspace-page/fork-tree";
import {
  changesWithForks,
  type ForkRow,
  filesChanged,
  forkRows,
  isWorkspaceActive,
  parseArtifactRef,
} from "../components/workspace-page/model";
import { getWorkspace, getWorkspaceFiles, type WorkspaceView } from "../lib/api";
import { formatAge, formatNumber, generation, generationCode, truncate } from "../lib/format";

/**
 * Code (Advanced; internal names Workspace, Artifacts, forks; AGENTS.md 38.5). The live code of
 * the current release, one working copy per task, and one copy per version. The fork tree and
 * every ref, tree and commit hash sit behind "Technical details" and "Show as tree".
 */

export const Route = createFileRoute("/projects_/$projectId/workspace")({
  component: WorkspacePage,
});

/** Forks change while Tasks run and Candidates verify; poll then, and stop when idle. */
const POLL_MS = 10_000;
/** Must match CHANGE_LIMIT in workers/api/src/workspace.ts. */
const CHANGE_LIMIT = 10;
const ALL = "all";

const INTRO = "The source code of each release and each version.";

function WorkspacePage() {
  return (
    <>
      <Show when="signed-in">
        <WorkspaceContent />
      </Show>
      <Show when="signed-out">
        <Page>
          <PageTitle title="Code" />
          <EmptyState
            what="Sign in to view this project's code."
            how="Projects are visible to members of their organization."
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
        title={<Term k="code" />}
        meta={
          <span className="text-[14px]">
            {INTRO}
            {view.data && <Summary view={view.data} />}
          </span>
        }
      />

      {view.isError && (
        <SectionError
          message={`The code could not load. ${view.error.message}`}
          onRetry={() => view.refetch()}
          retrying={view.isFetching}
        />
      )}

      {view.data && !view.data.canonical.assigned ? (
        <Section label="Live code">
          <EmptyState
            what="This project has no code yet."
            how="Load the demo code from the Overview to start."
            action={
              <Link
                to="/projects/$projectId"
                params={{ projectId }}
                className={buttonVariants({ variant: "secondary" })}
              >
                Open Overview
              </Link>
            }
          />
        </Section>
      ) : (
        <>
          <Section label="Live code">
            {view.data ? (
              <LiveCode view={view.data} commit={commit} commitPending={files.isPending} />
            ) : (
              <div className="grid gap-2">
                <SkeletonBar height={13} className="w-1/3" />
                <SkeletonBar height={12} className="w-1/2" />
              </div>
            )}
          </Section>
          <Copies view={view.data} commit={commit} />
          <Section
            label="Files in the live release"
            meta={
              files.data?.indexed && (
                <span>
                  {formatNumber(files.data.files.length)}
                  {files.data.truncated ? "+" : ""} files
                </span>
              )
            }
          >
            {files.isError ? (
              <SectionError
                message={`The file list could not load. ${files.error.message}`}
                onRetry={() => files.refetch()}
                retrying={files.isFetching}
              />
            ) : files.data ? (
              <>
                <FileBrowser key={files.data.treeSha} index={files.data} />
                <p className="text-[12px] text-kumo-subtle">
                  Only file paths are stored, so sizes and file contents are not shown.
                  {files.data.truncated && " The list stops at 2,000 paths."}
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
        </>
      )}
    </Page>
  );
}

/** One sentence in place of the old stat strip. */
function Summary({ view }: { view: WorkspaceView }) {
  if (!view.canonical.assigned) return null;
  const running = view.workspaces.filter((w) => w.runStatus === "running").length;
  const parts = [
    generation(view.canonical.generation),
    `${formatNumber(view.workspaces.length)} working ${view.workspaces.length === 1 ? "copy" : "copies"}${running ? ` (${formatNumber(running)} in progress)` : ""}`,
    `${formatNumber(view.candidates.length)} ${view.candidates.length === 1 ? "version" : "versions"}`,
  ];
  return (
    <span className="text-kumo-subtle">
      {" "}
      {parts.join(" · ")}
      {view.truncated ? ` · latest ${CHANGE_LIMIT} changes` : ""}.
    </span>
  );
}

function LiveCode({
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
    <div className="grid gap-3 rounded-lg border border-kumo-rule bg-kumo-elevated p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[16px] font-semibold">
          <Term k="release">{generation(canonical.generation)}</Term>
        </span>
        {canonical.updatedAt && (
          <span className="text-[13px] text-kumo-subtle">
            updated{" "}
            <time dateTime={canonical.updatedAt} title={canonical.updatedAt}>
              {formatAge(canonical.updatedAt)}
            </time>
          </span>
        )}
        {canonical.lastPromotedCandidateId && (
          <Link
            to="/candidates/$candidateId"
            params={{ candidateId: canonical.lastPromotedCandidateId }}
            className="text-[13px] text-kumo-link hover:underline"
          >
            Open the version that shipped
          </Link>
        )}
      </div>
      <TechnicalDetails>
        <KeyValue
          items={[
            { label: "Generation", value: generationCode(canonical.generation), mono: true },
            { label: "Artifact", value: canonical.artifactRef, mono: true },
            { label: "Repo", value: ref.repo, mono: true },
            { label: "Branch", value: ref.ref, mono: true },
            { label: "Commit", value: commit ?? (commitPending ? "Loading" : null), mono: true },
            { label: "Tree", value: canonical.treeSha, mono: true },
            {
              label: "Last promotion",
              value: canonical.lastPromotedCandidateId,
              mono: true,
            },
            // No build record is stored yet (AGENTS.md 38.5 lists build state); shown as unknown.
            { label: "Build", value: null },
          ]}
        />
      </TechnicalDetails>
    </div>
  );
}

/** A native disclosure for internal names and hashes (spec rule 9). */
function TechnicalDetails({
  label = "Technical details",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <details className="group">
      <summary className="w-fit cursor-pointer text-[13px] text-kumo-link">{label}</summary>
      <div className="mt-2 min-w-0">{children}</div>
    </details>
  );
}

/** Change filter, the two lists (working copies, versions) and the selected row's detail. */
function Copies({ view, commit }: { view: WorkspaceView | undefined; commit: string | null }) {
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
  const copies = rows.filter((r) => r.kind === "workspace");
  const versions = rows.filter((r) => r.kind === "candidate");
  const select = (key: string) => {
    if (!rows.some((r) => r.key === key)) {
      const target = rowsByKey.get(key);
      if (target) setChangeFilter(target.fork.changeId);
    }
    setSelected(key);
  };

  if (!view) {
    return (
      <Section label="Working copies">
        <div className="grid gap-2" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <SkeletonBar key={i} height={13} className={i === 0 ? "w-1/2" : "w-full"} />
          ))}
        </div>
      </Section>
    );
  }
  if (total === 0) {
    return (
      <Section label="Working copies">
        <EmptyState
          what="No working copies yet."
          how="A copy appears when an agent starts editing code for a task, and a version when the task results are combined."
        />
      </Section>
    );
  }

  return (
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
        <div className="grid min-w-0 content-start gap-7">
          <Section label="Working copies" meta={<span>one per task</span>}>
            {copies.length === 0 ? (
              <p className="text-[13px] text-kumo-subtle">No working copy for this change.</p>
            ) : (
              <RowList
                label="Working copies"
                rows={copies}
                selectedKey={selectedRow?.key ?? null}
                rowsByKey={rowsByKey}
                onSelect={select}
              />
            )}
          </Section>
          <Section label={<Term k="version">Versions</Term>}>
            {versions.length === 0 ? (
              <p className="text-[13px] text-kumo-subtle">
                No version yet. A version appears when the task results are combined.
              </p>
            ) : (
              <RowList
                label="Versions"
                rows={versions}
                selectedKey={selectedRow?.key ?? null}
                rowsByKey={rowsByKey}
                onSelect={select}
              />
            )}
          </Section>
          <TechnicalDetails label="Show as tree">
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
          </TechnicalDetails>
        </div>
        <div className="grid min-w-0 content-start rounded-lg border border-kumo-rule bg-kumo-elevated p-4">
          <ForkInspector row={selectedRow} rowsByKey={rowsByKey} onSelect={select} />
        </div>
      </div>
    </>
  );
}

/** One button row per working copy or version: name, files changed, status. */
function RowList({
  label,
  rows,
  selectedKey,
  rowsByKey,
  onSelect,
}: {
  label: string;
  rows: ForkRow[];
  selectedKey: string | null;
  rowsByKey: Map<string, ForkRow>;
  onSelect: (key: string) => void;
}) {
  return (
    <ul aria-label={label} className="grid">
      {rows.map((row) => {
        const selected = row.key === selectedKey;
        const name =
          row.kind === "workspace" ? (row.fork.taskTitle ?? row.fork.taskKey ?? "Task") : row.label;
        const count = filesChanged(row, rowsByKey);
        return (
          <li key={row.key} className="border-b border-kumo-rule">
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(row.key)}
              className={cn(
                "grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-md px-2 py-2 text-left transition-colors duration-150 hover:bg-kumo-row-hover focus-visible:outline-offset-[-2px]",
                selected && "bg-kumo-faint",
              )}
            >
              <span className={cn("min-w-0 truncate text-[14px]", selected && "font-semibold")}>
                {truncate(name, 80)}
              </span>
              <StatusPill
                status={row.status}
                {...(row.kind === "workspace" && row.statusLabel ? { label: row.statusLabel } : {})}
              />
              <span className="col-span-2 text-[12px] text-kumo-subtle">
                {count === null ? (
                  "No files changed yet"
                ) : (
                  <>
                    {formatNumber(count)} {count === 1 ? "file" : "files"} changed{" "}
                    <AddsDels adds={row.adds} dels={row.dels} className="font-mono" />
                  </>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Filter chips: one per Change with copies, plus All. */
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
    { id: ALL, label: "All changes", title: "Every loaded change", count: total },
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
              "flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1 text-[12px] transition-colors duration-150 pointer-coarse:min-h-11",
              selected
                ? "border-kumo-ink bg-kumo-tint font-semibold"
                : "border-kumo-rule hover:bg-kumo-tint",
            )}
          >
            <span className="max-w-[36ch] truncate">{chip.label}</span>
            <Mono subtle>{formatNumber(chip.count)}</Mono>
          </button>
        );
      })}
    </fieldset>
  );
}
