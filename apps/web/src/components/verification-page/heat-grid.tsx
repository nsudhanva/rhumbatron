import { cn } from "@cloudflare/kumo";
import { Link } from "@tanstack/react-router";
import { truncate } from "../../lib/format";
import { criterion, REASON_WORDS, verdictWord } from "../candidate/model";
import { GRID_COLUMNS, type HeatCell, heatCell, type VerifiedCandidate } from "./model";

type Level = HeatCell["verdict"];

/**
 * Each level has a fill, a mark (status is a sign, not only a color) and a legend word. A check
 * that did not run is amber, never green: only a `checked_supported` pass is `pass`.
 */
const LEVEL: Record<Level, { fill: string; mark: string; word: string }> = {
  pass: { fill: "bg-kumo-success text-kumo-inverse", mark: "✓", word: "Passed" },
  fail: { fill: "bg-kumo-danger text-kumo-inverse", mark: "✕", word: "Failed" },
  gap: { fill: "bg-kumo-warning text-kumo-inverse", mark: "!", word: "Not run (never a pass)" },
  pending: { fill: "bg-tone-300 text-tone-800", mark: "·", word: "Queued" },
  none: { fill: "bg-kumo-faint text-kumo-subtle", mark: "", word: "Not planned" },
};

const LEGEND: Level[] = ["pass", "fail", "gap", "pending", "none"];

const index = (n: number) => String(n).padStart(2, "0");

const kindTitle = (kind: string) =>
  criterion({ checkId: kind, kind, check: undefined }, null).title;

function cellTitle(item: VerifiedCandidate, kind: string, cell: HeatCell) {
  const head = `${index(item.gridIndex ?? 0)} · ${item.label} · ${kindTitle(kind)}`;
  if (cell.verdict === "none") return `${head}: not planned for this version`;
  const parts = cell.rows.map((r) => {
    const word = verdictWord(r);
    const title = criterion(r, item.budget).title;
    return r.reason ? `${title} ${word} (${REASON_WORDS[r.reason]})` : `${title} ${word}`;
  });
  return `${head}: ${parts.join("; ")}`;
}

/**
 * Heat grid (Advanced, spec B.1/B.2) of check kind (rows) by recent version (columns, oldest
 * left). Square cells in a fixed 16-column track that scrolls sideways, a title on every cell and
 * a legend underneath. Each cell links to its version. Fill changes animate over the heat-grid
 * duration; this is the only page that keeps that transition.
 */
export function HeatGrid({ items, kinds }: { items: VerifiedCandidate[]; kinds: string[] }) {
  const columns = items
    .filter((i) => i.gridIndex !== null)
    .sort((a, b) => (a.gridIndex ?? 0) - (b.gridIndex ?? 0));
  const slots = Array.from({ length: GRID_COLUMNS }, (_, i) => columns[i]);
  return (
    <div className="grid min-w-0 gap-3">
      <div className="min-w-0 overflow-x-auto">
        <table className="border-separate border-spacing-0.5" aria-label="Check results by version">
          <thead>
            <tr>
              <th scope="col" className="sr-only">
                Check
              </th>
              {slots.map((item, i) => (
                <th
                  // biome-ignore lint/suspicious/noArrayIndexKey: grid slots are positional
                  key={i}
                  scope="col"
                  title={
                    item
                      ? `${index(i + 1)} · ${item.label} · ${truncate(item.change?.goal ?? item.candidate.changeId, 80)}`
                      : `${index(i + 1)} · no version`
                  }
                  className="w-7 p-0 pb-1 text-center align-bottom font-mono text-[12px] font-normal text-kumo-subtle tabular-nums"
                >
                  {index(i + 1)}
                  {item && <span className="sr-only"> {item.label}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {kinds.map((kind) => (
              <tr key={kind}>
                <th
                  scope="row"
                  className="max-w-48 truncate pr-3 text-left text-[12px] font-normal whitespace-nowrap"
                  title={kind}
                >
                  {kindTitle(kind)}
                </th>
                {slots.map((item, i) => {
                  if (!item) {
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: grid slots are positional
                      <td key={i} className="p-0">
                        <span
                          aria-hidden
                          className="block size-7 border border-dashed border-kumo-rule"
                        />
                      </td>
                    );
                  }
                  const cell = heatCell(item, kind);
                  const level = LEVEL[cell.verdict];
                  const title = cellTitle(item, kind, cell);
                  return (
                    <td key={item.candidate.id} className="p-0">
                      <Link
                        to="/candidates/$candidateId"
                        params={{ candidateId: item.candidate.id }}
                        title={title}
                        aria-label={title}
                        className={cn(
                          "grid aspect-square size-7 place-items-center rounded-sm text-[12px] font-semibold",
                          "transition-colors duration-(--rh-dur-heat)",
                          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500",
                          level.fill,
                        )}
                      >
                        <span aria-hidden>{level.mark}</span>
                      </Link>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1.5 text-[12px]">
        {LEGEND.map((l) => (
          <li key={l} className="flex items-center gap-1.5">
            <span aria-hidden className={cn("block size-2.5 rounded-sm", LEVEL[l].fill)} />
            <span>
              {LEVEL[l].mark && (
                <span className="font-mono text-kumo-subtle">{LEVEL[l].mark} </span>
              )}
              {LEVEL[l].word}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
HeatGrid.displayName = "HeatGrid";
