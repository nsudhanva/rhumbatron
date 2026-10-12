import { Button, cn } from "@cloudflare/kumo";
import { ArrowLeft, FolderSimple, MagnifyingGlass, TerminalWindow } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CodeSessionError,
  type CodeSessionResult,
  closeCodeSession,
  deleteSessionFile,
  execSessionCommand,
  getCodeSession,
  isSessionGone,
  openCodeSession,
  readSessionFile,
  renameSessionFile,
  SESSION_FILE_MAX_BYTES,
  submitCodeSession,
  unwrap,
  writeSessionFile,
} from "../../lib/api-code-session";
import { formatNumber, generation } from "../../lib/format";
import { CodeEditor } from "../code/code-editor";
import { SectionError, SkeletonBar } from "../project/feedback";
import { EmptyState } from "../ui/empty-state";
import { Mono } from "../ui/mono";
import { shortSha } from "../workspace-page/model";
import { IdeStatusBar } from "./ide-status-bar";
import { IdeTabs } from "./ide-tabs";
import { IdeTerminal } from "./ide-terminal";
import { IdeTree } from "./ide-tree";
import { byteLength, type IdeTab, isDirty, sessionDeadline } from "./model";
import { QuickOpen } from "./quick-open";

/** Files opened first when the page names none. */
const DEFAULT_FILES = ["README.md", "readme.md", "package.json"];
/** Narrow layout: the tree and the terminal become drawers (the shell's narrow width). */
const NARROW = "(max-width: 720px)";

type Ended = "expired" | "gone";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Code page edit session: an IDE in the Flight panel dress. The file tree of
 * the session fork on the left, open-file tabs and the CodeMirror editor in the center, a
 * resizable terminal at the bottom, and a status bar with the idle countdown, Submit as change
 * and Discard session. Keys: Cmd/Ctrl+S saves the active tab, Cmd/Ctrl+P opens a file by path,
 * Ctrl+` (Cmd+` where the system allows) shows or hides the terminal. The page loads this module
 * only when a session starts, so browsing the code never downloads it.
 */
export default function CodeIde({
  projectId,
  initialPath,
  onLeave,
}: {
  projectId: string;
  initialPath?: string | undefined;
  /** Back to browsing; the session stays open until it ends. */
  onLeave: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState(0);
  const [ended, setEnded] = useState<Ended | null>(null);
  const [lastRequestAt, setLastRequestAt] = useState(() => Date.now());
  const [tabs, setTabs] = useState<IdeTab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  const [treeOpen, setTreeOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(() => !window.matchMedia(NARROW).matches);
  const [terminalHeight, setTerminalHeight] = useState(220);
  const [quickOpen, setQuickOpen] = useState(false);
  const terminalInput = useRef<HTMLInputElement>(null);
  const focusTerminal = useRef(false);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => {
    const media = window.matchMedia(NARROW);
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const open = useQuery({
    queryKey: ["code-session-open", projectId, attempt],
    queryFn: async () => {
      const session = unwrap(await openCodeSession({ data: projectId }));
      setLastRequestAt(Date.now());
      return session;
    },
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const sessionId = open.data?.sessionId;

  /** Every session request: a success keeps the countdown fresh; 404 or 410 ends the view. */
  const call = useCallback(async <T,>(pending: Promise<CodeSessionResult<T>>): Promise<T> => {
    const result = await pending;
    if (result.ok) {
      setLastRequestAt(Date.now());
      return result.data;
    }
    const error = new CodeSessionError(result.status, result.message, result.reason);
    if (isSessionGone(error)) setEnded("gone");
    throw error;
  }, []);

  const detail = useQuery({
    queryKey: ["code-session", sessionId],
    queryFn: async () => {
      try {
        return await call(getCodeSession({ data: sessionId ?? "" }));
      } catch (error) {
        // The session itself is not found: it was cleaned up.
        if (error instanceof CodeSessionError && error.status === 404) setEnded("gone");
        throw error;
      }
    },
    enabled: !!sessionId && !ended,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const files = detail.data?.files;
  const paths = useMemo(() => (files ?? []).map((f) => f.path), [files]);
  const changedCount = useMemo(() => {
    const set = new Set(detail.data?.changedFiles ?? []);
    for (const f of files ?? []) if (f.changed) set.add(f.path);
    return set.size;
  }, [detail.data?.changedFiles, files]);
  const { refetch } = detail;
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  const patchTab = useCallback((path: string, patch: Partial<IdeTab>) => {
    setTabs((current) => current.map((t) => (t.path === path ? { ...t, ...patch } : t)));
  }, []);

  const openFile = useCallback(
    async (path: string) => {
      if (narrow) setTreeOpen(false);
      setActive(path);
      if (!sessionId || tabsRef.current.some((t) => t.path === path)) return;
      setTabs((current) => [...current, { path, state: "loading", saved: "", draft: "" }]);
      try {
        const file = await call(readSessionFile({ data: { sessionId, path } }));
        patchTab(path, { state: "ready", saved: file.content, draft: file.content });
      } catch (error) {
        const refused =
          error instanceof CodeSessionError && (error.status === 413 || error.status === 415);
        patchTab(path, {
          state: "error",
          error: refused
            ? "This file is binary or larger than 256 KB, so it does not open in the editor. Change it with a terminal command."
            : `The file could not load. ${errorText(error)}`,
        });
      }
    },
    [call, narrow, patchTab, sessionId],
  );

  // The file the page named, else a default file, opens once the tree is known.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !files) return;
    opened.current = true;
    const first =
      initialPath && paths.includes(initialPath)
        ? initialPath
        : DEFAULT_FILES.find((p) => paths.includes(p));
    if (first) void openFile(first);
  }, [files, initialPath, openFile, paths]);

  const closeTab = useCallback((path: string) => {
    const current = tabsRef.current;
    const index = current.findIndex((t) => t.path === path);
    const rest = current.filter((t) => t.path !== path);
    setTabs(rest);
    setActive((was) =>
      was === path ? (rest[Math.min(index, rest.length - 1)]?.path ?? null) : was,
    );
  }, []);

  /** Saves one tab; resolves to an error message, or null when saved or unchanged. */
  const saveTab = useCallback(
    async (path: string): Promise<string | null> => {
      const tab = tabsRef.current.find((t) => t.path === path);
      if (!sessionId || !tab || !isDirty(tab) || tab.saving) return null;
      const content = tab.draft;
      if (byteLength(content) > SESSION_FILE_MAX_BYTES) {
        const message = "The file is over 256 KB, the largest file a session can write.";
        patchTab(path, { saveError: message });
        return message;
      }
      patchTab(path, { saving: true, saveError: undefined });
      try {
        await call(writeSessionFile({ data: { sessionId, path, content } }));
        patchTab(path, { saving: false, saved: content });
        refresh();
        return null;
      } catch (error) {
        const message = `Not saved. ${errorText(error)}`;
        patchTab(path, { saving: false, saveError: message });
        return message;
      }
    },
    [call, patchTab, refresh, sessionId],
  );

  const createFile = useCallback(
    async (path: string) => {
      if (!sessionId) return "The session is not open.";
      try {
        await call(writeSessionFile({ data: { sessionId, path, content: "" } }));
        setTabs((current) =>
          current.some((t) => t.path === path)
            ? current
            : [...current, { path, state: "ready", saved: "", draft: "" }],
        );
        setActive(path);
        refresh();
        return null;
      } catch (error) {
        return errorText(error);
      }
    },
    [call, refresh, sessionId],
  );

  const renameFile = useCallback(
    async (from: string, to: string) => {
      if (!sessionId) return "The session is not open.";
      try {
        await call(renameSessionFile({ data: { sessionId, from, to } }));
        setTabs((current) => current.map((t) => (t.path === from ? { ...t, path: to } : t)));
        setActive((was) => (was === from ? to : was));
        refresh();
        return null;
      } catch (error) {
        return errorText(error);
      }
    },
    [call, refresh, sessionId],
  );

  const deleteFile = useCallback(
    async (path: string) => {
      if (!sessionId) return "The session is not open.";
      try {
        await call(deleteSessionFile({ data: { sessionId, path } }));
        closeTab(path);
        refresh();
        return null;
      } catch (error) {
        return errorText(error);
      }
    },
    [call, closeTab, refresh, sessionId],
  );

  const exec = useCallback(
    async (command: string) => {
      if (!sessionId) throw new Error("The session is not open.");
      const result = await call(execSessionCommand({ data: { sessionId, command } }));
      // A command can change files: the tree reloads, and so do open tabs without edits.
      refresh();
      for (const tab of tabsRef.current) {
        if (tab.state !== "ready" || isDirty(tab)) continue;
        void call(readSessionFile({ data: { sessionId, path: tab.path } })).then(
          (file) => {
            const now = tabsRef.current.find((t) => t.path === tab.path);
            if (now && !isDirty(now) && now.saved !== file.content) {
              patchTab(tab.path, { saved: file.content, draft: file.content });
            }
          },
          (error: unknown) => {
            if (error instanceof CodeSessionError && error.status === 404) {
              patchTab(tab.path, {
                state: "error",
                error: "A command deleted or moved this file.",
              });
            }
          },
        );
      }
      return result;
    },
    [call, patchTab, refresh, sessionId],
  );

  const submit = useCallback(
    async (message: string) => {
      if (!sessionId) return "The session is not open.";
      for (const tab of tabsRef.current) {
        if (!isDirty(tab)) continue;
        const problem = await saveTab(tab.path);
        if (problem) return `${tab.path}: ${problem}`;
      }
      try {
        const fresh = unwrap(await getCodeSession({ data: sessionId }));
        const anyChange = fresh.changedFiles.length > 0 || fresh.files.some((f) => f.changed);
        if (!anyChange) {
          return `Nothing to submit: no file differs from ${generation(fresh.baseGeneration)}.`;
        }
        const result = await call(submitCodeSession({ data: { sessionId, message } }));
        await queryClient.invalidateQueries({ queryKey: ["changes", projectId] });
        queryClient.removeQueries({ queryKey: ["code-session", sessionId] });
        await navigate({ to: "/changes/$changeId", params: { changeId: result.changeId } });
        return null;
      } catch (error) {
        return `The Change was not created. ${errorText(error)}`;
      }
    },
    [call, navigate, projectId, queryClient, saveTab, sessionId],
  );

  const discard = useCallback(async () => {
    if (!sessionId) return null;
    const result = await closeCodeSession({ data: sessionId });
    if (!result.ok && result.status !== 404 && result.status !== 410) {
      return `The session did not close. ${result.message}`;
    }
    queryClient.removeQueries({ queryKey: ["code-session", sessionId] });
    onLeave();
    return null;
  }, [onLeave, queryClient, sessionId]);

  const onExpired = useCallback(() => setEnded("expired"), []);
  const restart = () => {
    setEnded(null);
    setTabs([]);
    setActive(null);
    opened.current = false;
    setAttempt((n) => n + 1);
  };

  const toggleTerminal = useCallback(() => {
    setTerminalOpen((was) => {
      focusTerminal.current = !was;
      return !was;
    });
  }, []);
  useEffect(() => {
    if (terminalOpen && focusTerminal.current) terminalInput.current?.focus();
    focusTerminal.current = false;
  }, [terminalOpen]);

  // Keys work anywhere on the page while the session is open (the editor included).
  const keys = useRef({ save: () => {}, quick: () => {}, terminal: () => {} });
  keys.current = {
    save: () => {
      if (active) void saveTab(active);
    },
    quick: () => setQuickOpen(true),
    terminal: toggleTerminal,
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "s" && !event.shiftKey) {
        event.preventDefault();
        keys.current.save();
      } else if (key === "p" && !event.shiftKey) {
        event.preventDefault();
        keys.current.quick();
      } else if (event.code === "Backquote" || key === "`") {
        event.preventDefault();
        keys.current.terminal();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const activeTab = tabs.find((t) => t.path === active) ?? null;
  const deadline = sessionDeadline(
    lastRequestAt,
    detail.data?.hardExpiresAt ?? open.data?.hardExpiresAt,
  );
  const base = detail.data ?? open.data;

  return (
    <section
      aria-label="Edit session"
      className="relative flex h-[clamp(480px,calc(100dvh-200px),1100px)] min-w-0 flex-col overflow-hidden rule-ink bg-kumo-elevated"
    >
      <div className="flex min-h-10 shrink-0 items-center justify-between gap-3 border-b-2 border-kumo-divider py-1 pr-1.5 pl-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <h2 className="type-h6 shrink-0">Edit session</h2>
          {base && (
            <span className="min-w-0 truncate text-[12px] text-kumo-subtle">
              from <Mono subtle>{generation(base.baseGeneration)}</Mono>
              <span className="max-[720px]:hidden">
                {" "}
                · commit <Mono subtle>{shortSha(base.baseCommit)}</Mono>
              </span>
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {narrow && (
            <Button
              size="sm"
              variant="ghost"
              shape="square"
              icon={<FolderSimple size={16} aria-hidden />}
              aria-label={treeOpen ? "Hide files" : "Show files"}
              aria-expanded={treeOpen}
              aria-controls="ide-tree"
              title="Files"
              onClick={() => setTreeOpen((v) => !v)}
            />
          )}
          <Button
            size="sm"
            variant="ghost"
            shape="square"
            icon={<MagnifyingGlass size={16} aria-hidden />}
            aria-label="Open a file by path"
            title="Open a file by path (Cmd/Ctrl+P)"
            disabled={!files}
            onClick={() => setQuickOpen(true)}
          />
          <Button
            size="sm"
            variant="ghost"
            shape="square"
            icon={<TerminalWindow size={16} aria-hidden />}
            aria-label={terminalOpen ? "Hide the terminal" : "Show the terminal"}
            aria-pressed={terminalOpen}
            title="Terminal (Ctrl+`)"
            onClick={toggleTerminal}
          />
          <Button
            size="sm"
            variant="ghost"
            icon={<ArrowLeft size={16} aria-hidden />}
            title="Back to browsing. The session stays open until it ends."
            onClick={onLeave}
          >
            <span className="max-[720px]:sr-only">Browse</span>
          </Button>
        </div>
      </div>

      {ended ? (
        <div className="grid content-start gap-3 bg-kumo-base p-4">
          <EmptyState
            what="This edit session ended."
            how={
              ended === "expired"
                ? "It ended after 10 minutes without a request (or 2 hours in total). Edits that were not submitted are discarded."
                : "It was closed, submitted or it expired. Edits that were not submitted are discarded."
            }
            action={
              <span className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" onClick={restart}>
                  Start a new session
                </Button>
                <Button size="sm" variant="ghost" onClick={onLeave}>
                  Back to browsing
                </Button>
              </span>
            }
          />
        </div>
      ) : open.isError ? (
        <div className="grid content-start gap-3 p-4">
          <SectionError
            message={
              open.error instanceof CodeSessionError && open.error.status === 403
                ? "Only the owner or an admin of this project can edit code."
                : `The edit session did not open. ${open.error.message}`
            }
            onRetry={() => open.refetch()}
            retrying={open.isFetching}
          />
          <div>
            <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={onLeave}>
              Back to browsing
            </Button>
          </div>
        </div>
      ) : !open.data ? (
        <div className="grid content-start gap-3 p-4" aria-busy>
          <p role="status" className="text-[13px] text-kumo-subtle">
            Opening an edit session: forking the canonical tree.
          </p>
          <SkeletonBar height={13} className="w-1/3" />
          <SkeletonBar height={13} className="w-1/2" />
          <SkeletonBar height={13} className="w-2/5" />
        </div>
      ) : (
        <>
          <div className="relative flex min-h-0 flex-1">
            <aside
              id="ide-tree"
              aria-label="Files"
              hidden={narrow && !treeOpen}
              className={cn(
                "min-h-0 bg-kumo-elevated",
                narrow
                  ? "absolute inset-y-0 left-0 z-30 w-[min(320px,88%)] border-r-2 border-kumo-divider shadow-[8px_0_24px_var(--color-kumo-shadow-drop)]"
                  : "w-[clamp(200px,24%,300px)] shrink-0 border-r border-kumo-rule",
              )}
            >
              {detail.isError && !files ? (
                <div className="p-3">
                  <SectionError
                    message={`The files did not load. ${detail.error.message}`}
                    onRetry={refresh}
                    retrying={detail.isFetching}
                  />
                </div>
              ) : files ? (
                <IdeTree
                  files={files}
                  selected={active}
                  onOpen={(path) => void openFile(path)}
                  onCreate={createFile}
                  onRename={renameFile}
                  onDelete={deleteFile}
                />
              ) : (
                <div className="grid gap-2 p-3" aria-busy>
                  {[0, 1, 2, 3, 4].map((i) => (
                    <SkeletonBar key={i} height={12} className={i % 2 ? "w-1/2" : "w-3/4"} />
                  ))}
                </div>
              )}
            </aside>

            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
              <IdeTabs tabs={tabs} active={active} onSelect={setActive} onClose={closeTab} />
              {activeTab && (
                <div className="flex min-h-8 shrink-0 items-center justify-between gap-3 border-b border-kumo-rule px-3 font-mono text-[11px] text-kumo-subtle max-[640px]:text-[12px]">
                  <span className="min-w-0 truncate" title={activeTab.path}>
                    {activeTab.path}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {activeTab.state === "ready" && (
                      <span role="status">
                        {activeTab.saving ? "saving" : isDirty(activeTab) ? "unsaved" : "saved"}
                      </span>
                    )}
                    {activeTab.state === "ready" && (
                      <Button
                        size="xs"
                        variant="secondary"
                        loading={!!activeTab.saving}
                        disabled={!isDirty(activeTab)}
                        title={isDirty(activeTab) ? "Save (Cmd/Ctrl+S)" : "No unsaved edits"}
                        onClick={() => void saveTab(activeTab.path)}
                      >
                        Save
                      </Button>
                    )}
                  </span>
                </div>
              )}
              {activeTab?.saveError && (
                <SectionError
                  className="shrink-0 py-1.5"
                  message={activeTab.saveError}
                  onRetry={() => void saveTab(activeTab.path)}
                />
              )}
              <div className="relative min-h-0 flex-1 overflow-hidden bg-kumo-base">
                {tabs.length === 0 && (
                  <div className="p-4">
                    <EmptyState
                      what="No file open."
                      how={
                        files && files.length === 0
                          ? "The fork has no files. Create one with New file."
                          : "Pick a file in the tree, or press Cmd/Ctrl+P to open one by path."
                      }
                    />
                  </div>
                )}
                {tabs.map((tab) => (
                  <div
                    key={tab.path}
                    role="tabpanel"
                    aria-label={tab.path}
                    hidden={tab.path !== active}
                    className="h-full overflow-hidden [&_.cm-editor]:h-full [&>textarea]:h-full"
                  >
                    {tab.state === "loading" ? (
                      <div className="grid gap-2 p-4" aria-busy>
                        <SkeletonBar height={12} className="w-2/3" />
                        <SkeletonBar height={12} className="w-1/2" />
                        <SkeletonBar height={12} className="w-3/5" />
                      </div>
                    ) : tab.state === "error" ? (
                      <div className="p-4">
                        <EmptyState what={tab.path} how={tab.error} />
                      </div>
                    ) : (
                      <CodeEditor
                        path={tab.path}
                        value={tab.draft}
                        onChange={(draft) => patchTab(tab.path, { draft })}
                      />
                    )}
                  </div>
                ))}
              </div>

              {sessionId && (
                <IdeTerminal
                  hidden={!terminalOpen}
                  exec={exec}
                  height={terminalHeight}
                  onResize={setTerminalHeight}
                  onCollapse={() => setTerminalOpen(false)}
                  overlay={narrow}
                  inputRef={terminalInput}
                />
              )}
              {!terminalOpen && !narrow && (
                <button
                  type="button"
                  onClick={toggleTerminal}
                  className="flex min-h-8 shrink-0 cursor-pointer items-center gap-2 border-t-2 border-kumo-divider px-3 text-left hover:bg-kumo-row-hover focus-visible:outline-offset-[-2px]"
                >
                  <TerminalWindow size={14} aria-hidden />
                  <span className="type-h6">Terminal</span>
                  <span className="font-mono text-[11px] text-kumo-subtle">Ctrl+`</span>
                </button>
              )}
            </div>
          </div>

          <IdeStatusBar
            sessionId={open.data.sessionId}
            baseGeneration={open.data.baseGeneration}
            deadline={deadline}
            changedCount={changedCount}
            defaultMessage={`Edit ${formatNumber(Math.max(changedCount, 1))} ${changedCount === 1 ? "file" : "files"} in the code editor`}
            onKeepAlive={refresh}
            keepingAlive={detail.isFetching}
            onSubmit={submit}
            onDiscard={discard}
            onExpired={onExpired}
          />
        </>
      )}

      <QuickOpen
        open={quickOpen}
        onOpenChange={setQuickOpen}
        paths={paths}
        onPick={(path) => void openFile(path)}
      />
    </section>
  );
}
CodeIde.displayName = "CodeIde";
