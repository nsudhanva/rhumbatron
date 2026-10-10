import { useMemo } from "react";
import type { CodeFile } from "../../lib/api";
import { formatNumber } from "../../lib/format";
import { EmptyState } from "../ui/empty-state";
import { shortSha } from "../workspace-page/model";
import { highlightLines, TOKEN_CLASS } from "./highlight";

const UNAVAILABLE: Record<NonNullable<CodeFile["unavailable"]>, string> = {
  binary: "This is a binary file, so it is not shown.",
  too_large: "This file is over 1 MB, so its contents are not stored.",
  not_stored: "This file's contents are not stored yet. Reload in a moment.",
};

export function formatBytes(n: number | null) {
  if (n === null) return null;
  if (n < 1024) return `${formatNumber(n)} B`;
  if (n < 1024 * 1024) return `${formatNumber(n / 1024, 1)} KB`;
  return `${formatNumber(n / (1024 * 1024), 1)} MB`;
}

/**
 * One file of a canonical tree in the diff viewer dress (DESIGN.md 9.10): an elevated mono well
 * with the path and blob in the header, then a 40px line-number gutter and the highlighted code.
 */
export function FileView({ file }: { file: CodeFile }) {
  const lines = useMemo(
    () => (file.content === null ? [] : highlightLines(file.content, file.path)),
    [file.content, file.path],
  );
  const digits = Math.max(2, String(lines.length).length);
  return (
    <figure className="min-w-0 rule-ink bg-kumo-elevated">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-kumo-rule px-3 py-2 font-mono text-[12px]">
        <span className="min-w-0 truncate font-semibold" title={file.path}>
          {file.path}
        </span>
        <span className="flex items-baseline gap-3 text-kumo-subtle">
          {file.content !== null && (
            <span>
              {formatNumber(lines.length)} {lines.length === 1 ? "line" : "lines"}
            </span>
          )}
          {file.size !== null && <span>{formatBytes(file.size)}</span>}
          <span title={file.blob}>blob {shortSha(file.blob)}</span>
        </span>
      </figcaption>
      {file.content === null ? (
        <div className="px-3">
          <EmptyState what={UNAVAILABLE[file.unavailable ?? "not_stored"]} />
        </div>
      ) : (
        <pre
          className="overflow-auto py-2 pr-3 font-mono text-[12px] leading-[1.7] whitespace-pre"
          style={{ maxHeight: 640 }}
        >
          {lines.map((tokens, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and never reorder
              key={index}
              className="grid grid-cols-[40px_minmax(0,1fr)] gap-3"
            >
              <span aria-hidden className="text-right text-kumo-subtle select-none">
                {String(index + 1).padStart(digits, "0")}
              </span>
              <code>
                {tokens.length === 0
                  ? " "
                  : tokens.map((token, t) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
                      <span key={t} className={TOKEN_CLASS[token.kind]}>
                        {token.text}
                      </span>
                    ))}
              </code>
            </span>
          ))}
        </pre>
      )}
    </figure>
  );
}
FileView.displayName = "FileView";
