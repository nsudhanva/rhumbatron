import type { ConflictDetail, RequestConflictDetail } from "../../lib/api";
import { formatNumber, truncate } from "../../lib/format";
import { ConflictCard, conflictKind, conflictLine } from "../conflict-card";
import { Section } from "../ui/page";
import { StatusPill } from "../ui/status-pill";
import { Disclosure } from "./disclosure";
import { RequestConflictCard } from "./request-conflict-card";

/**
 * Conflicts of one Change as a short list (AGENTS.md section 32): one line per conflict, the full
 * card on expand. Design conflicts are between the agents' Intents inside this Change; request
 * conflicts are between this Change and another person's request.
 */
export function ConflictList({
  changeId,
  conflicts,
  requestConflicts,
  outcomeReason,
}: {
  changeId: string;
  conflicts: ConflictDetail[];
  requestConflicts: RequestConflictDetail[];
  outcomeReason: string | null | undefined;
}) {
  const total = conflicts.length + requestConflicts.length;
  if (total === 0) return null;
  const open = conflicts.filter((c) => c.state !== "resolved").length;
  return (
    <div id="conflicts" className="grid scroll-mt-4">
      <Section
        label="Conflicts"
        meta={
          <span className="font-mono tabular-nums">
            {formatNumber(open)} open · {formatNumber(total)} total
          </span>
        }
      >
        <ul className="grid">
          {requestConflicts.map((rc) => {
            const other = rc.a.changeId === changeId ? rc.b : rc.a;
            const won = rc.winnerChangeId === changeId;
            const lost = rc.winnerChangeId !== null && !won;
            return (
              <li key={rc.id} className="border-b border-kumo-rule">
                <Disclosure
                  label={
                    <span className="font-normal">
                      <span className="font-semibold">Request conflict</span> with "
                      {truncate(other.goal, 90)}"
                    </span>
                  }
                  meta={
                    <StatusPill
                      status={won ? "selected" : lost ? "not_selected" : "waiting"}
                      family={won ? "ok" : lost ? "idle" : "attention"}
                      label={won ? "This goes ahead" : lost ? "Other goes ahead" : "Undecided"}
                    />
                  }
                >
                  <RequestConflictCard
                    conflict={rc}
                    currentChangeId={changeId}
                    fallbackReason={outcomeReason}
                  />
                </Disclosure>
              </li>
            );
          })}
          {conflicts.map((c) => {
            const kind = conflictKind(c);
            return (
              <li key={c.id} className="border-b border-kumo-rule">
                <Disclosure
                  label={
                    <span className="font-normal">
                      <span className="font-semibold">Design conflict</span>
                      {kind ? ` · ${kind}` : ""} · {conflictLine(c)}
                    </span>
                  }
                  meta={<StatusPill status={c.state} />}
                >
                  <ConflictCard conflict={c} headless />
                </Disclosure>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}
ConflictList.displayName = "ConflictList";
