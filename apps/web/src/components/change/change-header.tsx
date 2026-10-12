import { cn } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import type { ChangeView } from "../../lib/api-change";
import { changeLabel, timeAgo } from "../../lib/format";
import { FAMILY_FILL } from "../ui/status-pill";
import { ChangeStatusWord, requesterName, type StatusLine } from "./change-status";

/**
 * Title block of the Change page: the status word, the short title, and the full
 * goal as asked, then one sentence on where the Change stands, who asked and when. Actions sit
 * bottom right: at most one primary, the rest secondary.
 */
export function ChangeHeader({
  change,
  line,
  actions,
  live,
}: {
  change: ChangeView;
  line: StatusLine;
  actions?: ReactNode;
  /** The live socket is open: updates arrive without a reload. */
  live?: boolean;
}) {
  const who = requesterName(change);
  const title = changeLabel(change);
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="grid min-w-0 gap-2">
        <p className="type-kicker flex flex-wrap items-center gap-2 text-kumo-accent">
          <span>Change</span>
          <ChangeStatusWord status={change.status} className="tracking-normal normal-case" />
        </p>
        <h1 className="type-h2 min-w-0 break-words">{title}</h1>
        {change.goal.trim() !== title && (
          <p className="max-w-[80ch] min-w-0 text-[14px] break-words whitespace-pre-line text-kumo-subtle">
            {change.goal}
          </p>
        )}
        <p className="flex min-w-0 items-start gap-2 text-[16px] font-semibold">
          <span aria-hidden className={cn("mt-[7px] size-2 shrink-0", FAMILY_FILL[line.family])} />
          <span role="status" aria-live="polite" className="min-w-0 text-pretty">
            {line.text}
          </span>
        </p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-kumo-subtle">
          {(change.requester || change.createdAt) && (
            <span>
              Asked
              {change.requester && (
                <>
                  {" "}
                  by <span className="font-semibold text-kumo-default">{who}</span>
                </>
              )}
              {change.createdAt && (
                <>
                  {" "}
                  <time dateTime={change.createdAt} title={change.createdAt}>
                    {timeAgo(change.createdAt)}
                  </time>
                </>
              )}
            </span>
          )}
          {live && (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="size-1.5 bg-kumo-success" />
                live
              </span>
            </>
          )}
        </p>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
ChangeHeader.displayName = "ChangeHeader";
