import { Collapsible, cn } from "@cloudflare/kumo";
import { CaretRight } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import type { ChangeSetAttribution, CodeDiff, DiffFile } from "../../lib/api";
import { formatNumber } from "../../lib/format";
import { EmptyState } from "../ui/empty-state";
import { AddsDels } from "../workspace-page/fork-tree";
import { highlightLines, TOKEN_CLASS, type Token } from "./highlight";

type Line = {
  kind: "hunk" | "add" | "del" | "context" | "note";
  number: number | null;
  tokens: Token[];
};

const LINE_CLASS: Record<Line["kind"], string> = {
  hunk: "text-kumo-subtle",
  add: "bg-kumo-success/9 text-kumo-success",
  del: "bg-kumo-danger/9 text-kumo-danger",
  context: "",
  note: "text-kumo-subtle italic",
};
const SIGN: Record<Line["kind"], string> = {
  hunk: "",
  add: "+",
  del: "−",
  context: "",
  note: "",
};

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Unified hunks to rows (DESIGN.md 9.10): the new line number for added and context lines, the
 * old one for removed lines. Code is highlighted as one text, so strings and comments that span
 * lines stay right; added and removed lines keep their status color.
 */
function diffLines(file: DiffFile): Line[] {
  const raw = file.patch ? file.patch.split("\n") : [];
  const code = raw.map((l) => (l.startsWith("@@") || l.startsWith("\\") ? "" : l.slice(1)));
  const highlighted = highlightLines(code.join("\n"), file.path);
  let oldNo = 0;
  let newNo = 0;
  return raw.map((line, index) => {
    const tokens = highlighted[index] ?? [];
    if (line.startsWith("@@")) {
      const match = HUNK.exec(line);
      oldNo = Number(match?.[1] ?? 0);
      newNo = Number(match?.[2] ?? 0);
      return { kind: "hunk", number: null, tokens: [{ text: line, kind: "plain" }] };
    }
    if (line.startsWith("\\")) {
      return { kind: "note", number: null, tokens: [{ text: line.slice(2), kind: "plain" }] };
    }
    if (line.startsWith("+")) return { kind: "add", number: newNo++, tokens };
    if (line.startsWith("-")) return { kind: "del", number: oldNo++, tokens };
    oldNo++;
    return { kind: "context", number: newNo++, tokens };
  });
}

function DiffBody({ file }: { file: DiffFile }) {
  const lines = useMemo(() => diffLines(file), [file]);
  if (file.binary) {
    return <p className="px-3 py-2 font-mono text-[12px] text-kumo-subtle">Binary file changed.</p>;
  }
  if (lines.length === 0) {
    return (
      <p className="px-3 py-2 font-mono text-[12px] text-kumo-subtle">
        {file.status === "renamed" ? "Renamed without changes." : "No line changes."}
      </p>
    );
  }
  return (
    <pre
      className="overflow-auto py-1 font-mono text-[12px] leading-[1.7] whitespace-pre"
      style={{ maxHeight: 560 }}
    >
      {lines.map((line, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
          key={index}
          className={cn("grid grid-cols-[40px_16px_minmax(0,1fr)] pr-3", LINE_CLASS[line.kind])}
        >
          <span aria-hidden className="pr-1.5 text-right text-kumo-subtle select-none">
            {line.number ?? ""}
          </span>
          <span aria-hidden className="text-center select-none">
            {SIGN[line.kind]}
          </span>
          <code>
            {line.kind === "add" || line.kind === "del" || line.tokens.length === 0
              ? line.tokens.map((t) => t.text).join("") || " "
              : line.tokens.map((token, t) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
                  <span key={t} className={TOKEN_CLASS[token.kind]}>
                    {token.text}
                  </span>
                ))}
          </code>
        </span>
      ))}
      {file.truncated && (
        <span className="block px-3 pt-1 text-kumo-subtle italic">
          The stored patch stops here (512 KB limit).
        </span>
      )}
    </pre>
  );
}

const STATUS_WORD: Record<DiffFile["status"], string | null> = {
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  modified: null,
};

/** "edited by <person>" for a human ChangeSet (P16-19), else the agent role and ID. */
export function Author({ set }: { set: ChangeSetAttribution }) {
  return set.editedBy !== null ? (
    <>
      edited by <span className="text-kumo-default">{set.editedBy}</span>
    </>
  ) : (
    <>
      {set.agentRole ?? "agent"} <span className="text-kumo-default">{set.agentId}</span>
    </>
  );
}
Author.displayName = "Author";

/** Agent and ChangeSet that produced a file, as compact mono links. */
export function Attribution({ sets }: { sets: ChangeSetAttribution[] }) {
  if (sets.length === 0) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-kumo-subtle">
      {sets.map((s) => (
        <span key={s.id} title={s.summary || s.id} className="whitespace-nowrap">
          <Author set={s} /> · {s.taskKey ?? s.id}
        </span>
      ))}
    </span>
  );
}
Attribution.displayName = "Attribution";

/**
 * Files changed (P16-18): one collapsible row per file with `+N −M` and, when known, the agent
 * and ChangeSet that changed it. A missing patch says so; it is never an error.
 */
export function DiffFiles({
  diff,
  changeSets = [],
  emptyHow,
}: {
  diff: CodeDiff;
  changeSets?: ChangeSetAttribution[];
  emptyHow?: string;
}) {
  const byId = useMemo(() => new Map(changeSets.map((s) => [s.id, s] as const)), [changeSets]);
  if (!diff.recorded) {
    return <EmptyState what="No diff recorded." how={emptyHow} />;
  }
  if (diff.files.length === 0) return <EmptyState what="No files changed." />;
  const adds = diff.files.reduce((n, f) => n + f.additions, 0);
  const dels = diff.files.reduce((n, f) => n + f.deletions, 0);
  return (
    <div className="grid min-w-0 gap-2">
      <p className="flex flex-wrap items-baseline gap-x-3 font-mono text-[12px] text-kumo-subtle">
        <span>
          {formatNumber(diff.files.length)} {diff.files.length === 1 ? "file" : "files"}
        </span>
        <AddsDels adds={adds} dels={dels} />
        {diff.truncated && (
          <span>patch cut at 512 KB of {formatNumber(Math.ceil(diff.bytes / 1024))} KB</span>
        )}
      </p>
      <div className="min-w-0 rule-ink bg-kumo-elevated">
        {diff.files.map((file) => {
          const sets = file.changeSetIds.flatMap((id) => byId.get(id) ?? []);
          return (
            <Collapsible.Root key={file.path} className="border-b border-kumo-rule last:border-b-0">
              <Collapsible.Trigger className="group grid w-full cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto] items-baseline gap-x-2 px-3 py-2 text-left font-mono text-[12px] transition-colors duration-(--rh-dur-ui) hover:bg-kumo-row-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500">
                <CaretRight
                  size={12}
                  aria-hidden
                  className="self-center text-kumo-subtle transition-transform duration-(--rh-dur-ui) group-data-[panel-open]:rotate-90"
                />
                <span className="grid min-w-0 gap-0.5">
                  <span className="min-w-0 truncate" title={file.path}>
                    <span className="font-semibold">{file.path}</span>
                    {file.oldPath && <span className="text-kumo-subtle"> ← {file.oldPath}</span>}
                    {STATUS_WORD[file.status] && (
                      <span className="text-kumo-subtle"> · {STATUS_WORD[file.status]}</span>
                    )}
                  </span>
                  <Attribution sets={sets} />
                </span>
                {file.binary ? (
                  <span className="text-kumo-subtle">binary</span>
                ) : (
                  <AddsDels adds={file.additions} dels={file.deletions} />
                )}
              </Collapsible.Trigger>
              <Collapsible.Panel className="border-t border-kumo-rule bg-kumo-base">
                <DiffBody file={file} />
              </Collapsible.Panel>
            </Collapsible.Root>
          );
        })}
      </div>
    </div>
  );
}
DiffFiles.displayName = "DiffFiles";

/** Link to a ChangeSet's Change, for history rows. */
export function ChangeLink({ change }: { change: { id: string; goal: string } }) {
  return (
    <Link
      to="/changes/$changeId"
      params={{ changeId: change.id }}
      className="text-kumo-link hover:underline"
      title={change.goal}
    >
      {change.goal}
    </Link>
  );
}
ChangeLink.displayName = "ChangeLink";
