import { Show, SignInButton } from "@clerk/tanstack-react-start";
import { Button, Select } from "@cloudflare/kumo";
import { SignIn } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { Attribution, ChangeLink } from "../components/code/diff-files";
import { FileView, formatBytes } from "../components/code/file-view";
import { SectionError, SkeletonBar } from "../components/project/feedback";
import { DataTable, RowLink, Td, Th, TitleCell, TRow } from "../components/ui/data-table";
import { EmptyState } from "../components/ui/empty-state";
import { Mono } from "../components/ui/mono";
import { Page, PageTitle, Section } from "../components/ui/page";
import { StatusPill } from "../components/ui/status-pill";
import { FileBrowser } from "../components/workspace-page/file-browser";
import { shortSha } from "../components/workspace-page/model";
import {
  type CodeTree,
  type CodeVersion,
  getCodeFile,
  getCodeTree,
  getCodeVersions,
  getProject,
} from "../lib/api";
import { EMPTY, formatNumber, generation, timeAgo, truncate } from "../lib/format";

/**
 * Code (P16-18; AGENTS.md 38.5): the files of any Canonical Generation, read-only, with the
 * version history and which agents changed what. Defaults to the live canonical tree.
 */

type Search = { tree?: string; path?: string };

export const Route = createFileRoute("/projects_/$projectId/code")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    ...(typeof search.tree === "string" && /^[0-9a-f]{40}$/.test(search.tree)
      ? { tree: search.tree }
      : {}),
    ...(typeof search.path === "string" && search.path.length > 0 && search.path.length <= 1024
      ? { path: search.path }
      : {}),
  }),
  component: CodePage,
});

/** Files opened first when none is chosen. */
const DEFAULT_FILES = ["README.md", "readme.md", "package.json"];

function CodePage() {
  return (
    <>
      <Show when="signed-in">
        <CodeContent />
      </Show>
      <Show when="signed-out">
        <Page>
          <PageTitle kicker="Project" title="Code" />
          <EmptyState
            what="Sign in to read this code."
            how="Code is visible to members of the project's organization."
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

function CodeContent() {
  const { projectId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject({ data: projectId }),
  });
  const versions = useQuery({
    queryKey: ["code-versions", projectId],
    queryFn: () => getCodeVersions({ data: projectId }),
  });
  const tree = useQuery({
    queryKey: ["code-tree", projectId, search.tree ?? "live"],
    queryFn: () => getCodeTree({ data: { projectId, tree: search.tree } }),
    // A partial tree is still being copied; read it again until it is complete.
    refetchInterval: (query) => (query.state.data?.contents === "partial" ? 5_000 : false),
  });
  const files = tree.data?.files;
  const path =
    search.path ?? DEFAULT_FILES.find((p) => files?.some((f) => f.path === p && f.stored));
  const treeSha = tree.data?.treeSha;
  const file = useQuery({
    queryKey: ["code-file", projectId, treeSha, path],
    queryFn: () => getCodeFile({ data: { projectId, tree: treeSha, path: path ?? "" } }),
    enabled: !!treeSha && !!path && !!files?.some((f) => f.path === path),
    // A tree's files never change.
    staleTime: Number.POSITIVE_INFINITY,
  });

  const version = versions.data?.versions.find((v) => v.treeSha && v.treeSha === treeSha);
  const index = useMemo(
    () =>
      tree.data
        ? {
            treeSha: tree.data.treeSha,
            indexed: true,
            commit: tree.data.commit,
            files: tree.data.files.map((f) => f.path),
            truncated: false,
          }
        : null,
    [tree.data],
  );

  const open = (next: string) =>
    navigate({ search: (prev) => ({ ...prev, path: next }), replace: true });

  return (
    <Page>
      <PageTitle
        kicker={project.data?.name ?? "Project"}
        title="Code"
        meta={
          tree.data && (
            <>
              {version && <Mono>{generation(version.generation)}</Mono>}
              {tree.data.live && <StatusPill status="live" />}
              <span aria-hidden>·</span>
              <span>
                commit <Mono subtle>{shortSha(tree.data.commit) || EMPTY}</Mono>
              </span>
              <span>
                tree <Mono subtle>{shortSha(tree.data.treeSha)}</Mono>
              </span>
            </>
          )
        }
      />

      <VersionPicker
        versions={versions.data?.versions}
        treeSha={treeSha}
        onPick={(next) =>
          navigate({
            search: ({ tree: _tree, ...prev }) =>
              next.live || !next.treeSha ? prev : { ...prev, tree: next.treeSha },
          })
        }
      />

      {tree.isError ? (
        <SectionError
          message={`The code could not load. ${tree.error.message}`}
          onRetry={() => tree.refetch()}
          retrying={tree.isFetching}
        />
      ) : (
        <div className="grid gap-7 min-[1100px]:grid-cols-[minmax(260px,360px)_minmax(0,1fr)]">
          <Section
            label="Files"
            meta={files && <Mono subtle>{formatNumber(files.length)} files</Mono>}
          >
            {index ? (
              <>
                <FileBrowser key={index.treeSha} index={index} onOpen={open} selected={path} />
                <ContentsNote tree={tree.data} />
              </>
            ) : (
              <div className="grid gap-2" aria-busy>
                {[0, 1, 2, 3].map((i) => (
                  <SkeletonBar key={i} height={13} className={i === 0 ? "w-1/2" : "w-3/4"} />
                ))}
              </div>
            )}
          </Section>
          <Section
            label="File"
            meta={file.data?.size != null && <Mono subtle>{formatBytes(file.data.size)}</Mono>}
          >
            {!path ? (
              <EmptyState what="No file open." how="Pick a file from the list." />
            ) : file.isError ? (
              <SectionError
                message={`The file could not load. ${file.error.message}`}
                onRetry={() => file.refetch()}
                retrying={file.isFetching}
              />
            ) : file.data ? (
              <FileView file={file.data} />
            ) : tree.data && !files?.some((f) => f.path === path) ? (
              <EmptyState what={`${path} is not in this version.`} how="Pick another file." />
            ) : (
              <div className="grid gap-2" aria-busy>
                <SkeletonBar height={12} className="w-2/3" />
                <SkeletonBar height={12} className="w-1/2" />
                <SkeletonBar height={12} className="w-3/5" />
              </div>
            )}
          </Section>
        </div>
      )}

      <History
        projectId={projectId}
        versions={versions.data?.versions}
        truncated={versions.data?.truncated ?? false}
        error={versions.isError ? versions.error.message : null}
        onRetry={() => versions.refetch()}
        treeSha={treeSha}
      />
    </Page>
  );
}

function ContentsNote({ tree }: { tree: CodeTree | undefined }) {
  if (!tree || tree.contents === "complete") return null;
  return (
    <p className="text-[11px] text-kumo-subtle">
      {tree.contents === "partial"
        ? "File contents are still being copied for this version."
        : "File contents are not stored for this version yet; only paths are listed."}
    </p>
  );
}

function versionLabel(v: CodeVersion) {
  const what = v.change ? truncate(v.change.goal, 64) : "Initial source";
  return `${generation(v.generation)} · ${what}${v.live ? " (live)" : ""}`;
}

function VersionPicker({
  versions,
  treeSha,
  onPick,
}: {
  versions: CodeVersion[] | undefined;
  treeSha: string | undefined;
  onPick: (version: CodeVersion) => void;
}) {
  const choices = (versions ?? []).filter((v) => v.treeSha);
  if (choices.length === 0) return null;
  return (
    <div className="grid gap-1.5">
      <span className="text-[12px] text-kumo-subtle" id="code-version-label">
        Version
      </span>
      <Select
        aria-labelledby="code-version-label"
        className="w-[min(480px,calc(100vw-32px))]"
        value={treeSha ?? null}
        onValueChange={(value) => {
          const picked = choices.find((v) => v.treeSha === value);
          if (picked) onPick(picked);
        }}
        items={Object.fromEntries(choices.map((v) => [v.treeSha as string, versionLabel(v)]))}
      />
    </div>
  );
}

/** History: S0..Sn, newest first, with the Change, the agents and a link to the diff. */
function History({
  projectId,
  versions,
  truncated,
  error,
  onRetry,
  treeSha,
}: {
  projectId: string;
  versions: CodeVersion[] | undefined;
  truncated: boolean;
  error: string | null;
  onRetry: () => void;
  treeSha: string | undefined;
}) {
  return (
    <Section
      label="History"
      meta={
        versions && (
          <Mono subtle>
            {formatNumber(versions.length)}
            {truncated ? "+" : ""} {versions.length === 1 ? "version" : "versions"}
          </Mono>
        )
      }
    >
      {error ? (
        <SectionError message={`History could not load. ${error}`} onRetry={onRetry} />
      ) : !versions ? (
        <div className="grid gap-2" aria-busy>
          <SkeletonBar height={13} className="w-1/2" />
          <SkeletonBar height={13} className="w-3/4" />
        </div>
      ) : versions.length === 0 ? (
        <EmptyState what="No versions yet." how="Seed the source on the project overview." />
      ) : (
        <DataTable label="Versions" minWidth={760}>
          <thead>
            <tr>
              <Th>Version</Th>
              <Th>Change</Th>
              <Th>Agents</Th>
              <Th>Diff</Th>
              <Th numeric>When</Th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <TRow key={v.generation} selected={!!v.treeSha && v.treeSha === treeSha}>
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
                <Td className="max-w-[360px]">
                  <span className="relative z-10 block truncate">
                    {v.change ? (
                      <ChangeLink change={v.change} />
                    ) : (
                      <span className="text-kumo-subtle">Initial source</span>
                    )}
                  </span>
                </Td>
                <Td className="font-mono text-[12px]">
                  {v.changeSets.length > 0 ? (
                    <Attribution sets={v.changeSets} />
                  ) : (
                    <span className="text-kumo-subtle">{EMPTY}</span>
                  )}
                </Td>
                <Td>
                  {v.candidateId ? (
                    <Link
                      to="/candidates/$candidateId"
                      params={{ candidateId: v.candidateId }}
                      className="relative z-10 text-kumo-link hover:underline"
                    >
                      Files changed
                    </Link>
                  ) : (
                    <span className="text-kumo-subtle">{EMPTY}</span>
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
            ))}
          </tbody>
        </DataTable>
      )}
    </Section>
  );
}
