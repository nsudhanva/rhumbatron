import { cn } from "@cloudflare/kumo";
import { Check, X } from "@phosphor-icons/react";
import type { CriterionAcceptance } from "../../lib/api-change";
import { formatNumber } from "../../lib/format";

/**
 * Per-criterion acceptance as a checklist (DESIGN.md 9.14): a success check for met, a danger
 * cross for not met, an empty square for unclear. Every row says its result in a word as well.
 * With `citations`, each row lists the source lines that support the judgement.
 */

const WORD: Record<CriterionAcceptance["status"], string> = {
  met: "Met",
  not_met: "Not met",
  unclear: "Unclear",
};

const WORD_TEXT: Record<CriterionAcceptance["status"], string> = {
  met: "text-kumo-success",
  not_met: "text-kumo-danger",
  unclear: "text-kumo-warning",
};

function acceptanceTally(items: CriterionAcceptance[]) {
  return {
    met: items.filter((i) => i.status === "met").length,
    total: items.length,
  };
}

function Mark({ status }: { status: CriterionAcceptance["status"] }) {
  if (status === "met") {
    return <Check aria-hidden size={14} weight="bold" className="mt-0.5 text-kumo-success" />;
  }
  if (status === "not_met") {
    return <X aria-hidden size={14} weight="bold" className="mt-0.5 text-kumo-danger" />;
  }
  return <span aria-hidden className="mt-0.5 size-3.5 border border-kumo-divider" />;
}

export function AcceptanceList({
  items,
  citations = false,
  className,
}: {
  items: CriterionAcceptance[];
  /** Show the cited source lines under each criterion. */
  citations?: boolean;
  className?: string;
}) {
  return (
    <ul className={cn("grid", className)}>
      {items.map((item) => (
        <li
          key={item.criterion}
          className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-1 border-b border-kumo-rule py-2 text-[13px]"
        >
          <Mark status={item.status} />
          <span className="min-w-0 text-pretty">{item.criterion}</span>
          <span
            className={cn("text-[12px] font-semibold whitespace-nowrap", WORD_TEXT[item.status])}
          >
            {WORD[item.status]}
          </span>
          {citations && item.citations.length > 0 && (
            <ul className="col-start-2 col-end-4 grid gap-1">
              {item.citations.map((c) => (
                <li key={`${c.path}:${c.quote}`} className="grid gap-0.5 bg-kumo-base px-2 py-1.5">
                  <span className="font-mono text-[11px] break-all text-kumo-subtle">{c.path}</span>
                  <code className="font-mono text-[11px] whitespace-pre-wrap break-words">
                    {c.quote}
                  </code>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
AcceptanceList.displayName = "AcceptanceList";

/** "4 / 5 met" header text. */
export function acceptanceSummary(items: CriterionAcceptance[]) {
  const t = acceptanceTally(items);
  return `${formatNumber(t.met)} / ${formatNumber(t.total)} met`;
}
