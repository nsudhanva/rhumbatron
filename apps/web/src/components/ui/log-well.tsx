import { cn } from "@cloudflare/kumo";
import type { ReactNode } from "react";

/** Line roles. Color is on the text only, never a line fill. */
export type LogLineRole = "cmd" | "info" | "pass" | "warn" | "fail";
export type LogLine = { text: string; role?: LogLineRole };

const ROLE_TEXT: Record<LogLineRole, string> = {
  cmd: "text-kumo-subtle",
  info: "text-kumo-default",
  pass: "text-kumo-success",
  warn: "text-kumo-warning",
  fail: "text-kumo-danger",
};

/**
 * Log viewer: elevated well with a 2px ink rule on top, a toolbar row
 * (filename left, actions right), zero-padded line numbers in a 34px gutter, mono 11.5px/1.7,
 * horizontal scroll, about 300px max height. Pass/fail summaries start with a word (`PASS`,
 * `FAIL`, `SKIPPED`) as well as the color.
 *
 *   <LogWell
 *     title="stdout.txt"
 *     toolbar={<Button size="xs" variant="ghost">Copy</Button>}
 *     lines={[{ text: "$ bun test", role: "cmd" }, { text: "PASS cart.test.ts", role: "pass" }]}
 *   />
 *
 * `lines` also accepts a raw string; each line then renders as `info`.
 */
export function LogWell({
  lines,
  title,
  toolbar,
  maxHeight = 300,
  className,
}: {
  lines: LogLine[] | string;
  title?: ReactNode;
  toolbar?: ReactNode;
  maxHeight?: number;
  className?: string;
}) {
  const rows: LogLine[] =
    typeof lines === "string" ? lines.split("\n").map((text) => ({ text })) : lines;
  const digits = Math.max(2, String(rows.length).length);
  return (
    <figure className={cn("min-w-0 rule-ink bg-kumo-elevated", className)}>
      {(title || toolbar) && (
        <figcaption className="flex items-center justify-between gap-3 border-b border-kumo-rule px-3 py-1.5 font-mono text-[10px] text-kumo-subtle">
          <span className="truncate">{title}</span>
          {toolbar && <span className="flex shrink-0 items-center gap-2">{toolbar}</span>}
        </figcaption>
      )}
      <pre className="type-mono-log overflow-auto py-2 pr-3 whitespace-pre" style={{ maxHeight }}>
        {rows.map((line, index) => (
          <span
            // Log lines have no identity besides their position.
            // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional and never reorder
            key={index}
            className="grid grid-cols-[34px_minmax(0,1fr)] gap-1.5"
          >
            <span aria-hidden className="text-right text-kumo-subtle select-none">
              {String(index + 1).padStart(digits, "0")}
            </span>
            <span className={ROLE_TEXT[line.role ?? "info"]}>{line.text || " "}</span>
          </span>
        ))}
      </pre>
    </figure>
  );
}
LogWell.displayName = "LogWell";

/**
 * Raw payload or receipt: pretty-printed JSON on `base` (inside an elevated
 * panel), mono 11px/1.5, about 260px max height, and one subtle caption line saying what the
 * payload is and what it deliberately leaves out.
 *
 *   <Payload value={receipt} caption="Decision Receipt as stored. Model reasoning is not recorded." />
 */
export function Payload({
  value,
  caption,
  maxHeight = 260,
  className,
}: {
  value: unknown;
  caption?: ReactNode;
  maxHeight?: number;
  className?: string;
}) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <figure className={cn("grid min-w-0 gap-1.5", className)}>
      <pre
        className="overflow-auto bg-kumo-base p-2.5 font-mono text-[11px] leading-[1.5] whitespace-pre"
        style={{ maxHeight }}
      >
        {text}
      </pre>
      {caption && <figcaption className="text-[11px] text-kumo-subtle">{caption}</figcaption>}
    </figure>
  );
}
Payload.displayName = "Payload";
