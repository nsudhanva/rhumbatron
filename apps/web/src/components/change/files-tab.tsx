import { formatNumber, plural } from "../../lib/format";
import type { ChangeFileView } from "./model";
import { statLine } from "./model";

/**
 * Files changed (docs/ux/research-2026-10-09.md 7.4 tabs): counts only, from the recorded code
 * changes. Diff text needs an API this page does not have. Before any code change is recorded,
 * the files the approaches planned to touch are listed and marked as planned.
 */
export function FilesTab({
  files,
  versionLabel,
}: {
  files: ChangeFileView;
  versionLabel: string | null;
}) {
  if (files.summary) {
    const { summary } = files;
    return (
      <section className="grid gap-3">
        <p className="text-[14px]">
          {files.source === "version" && versionLabel
            ? `${versionLabel} changes ${plural(summary.files.length, "file")}`
            : `The tasks changed ${plural(summary.files.length, "file")} so far`}{" "}
          <span className="text-kumo-subtle tabular-nums">({statLine(summary)})</span>
          {!summary.complete && (
            <span className="text-kumo-subtle">. Some code changes are not listed yet.</span>
          )}
        </p>
        <ul className="grid rounded-lg border border-kumo-rule">
          {summary.files.map((file) => (
            <li
              key={file.path}
              className="flex items-baseline justify-between gap-3 border-b border-kumo-rule px-3 py-2 last:border-b-0"
            >
              <span className="min-w-0 font-mono text-[13px] break-all">{file.path}</span>
              <span className="shrink-0 font-mono text-[12px] tabular-nums">
                {file.adds === null || file.dels === null ? (
                  <span className="text-kumo-subtle">binary</span>
                ) : (
                  <>
                    <span className="text-kumo-success">+{formatNumber(file.adds)}</span>{" "}
                    <span className="text-kumo-danger">
                      {"−"}
                      {formatNumber(file.dels)}
                    </span>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>
    );
  }
  if (files.planned.length > 0) {
    return (
      <section className="grid gap-3">
        <p className="text-[14px]">
          {plural(files.planned.length, "file")} (planned). The agents said they will touch these;
          no code change is recorded yet.
        </p>
        <ul className="grid rounded-lg border border-kumo-rule">
          {files.planned.map((path) => (
            <li
              key={path}
              className="border-b border-kumo-rule px-3 py-2 font-mono text-[13px] break-all text-kumo-subtle last:border-b-0"
            >
              {path}
            </li>
          ))}
        </ul>
      </section>
    );
  }
  return <p className="text-[14px] text-kumo-subtle">No files changed yet.</p>;
}
FilesTab.displayName = "FilesTab";
