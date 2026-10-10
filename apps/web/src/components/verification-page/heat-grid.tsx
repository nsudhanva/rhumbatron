import { cn } from "@cloudflare/kumo";
import { Link } from "@tanstack/react-router";
import { truncate } from "../../lib/format";
import { criterion, REASON_WORDS } from "../candidate/model";
import { statusView } from "../ui/status-pill";
import { GRID_COLUMNS, type HeatCell, heatCell, type VerifiedCandidate } from "./model";

type Level = HeatCell["verdict"];

/**
 * Each level has a fill, a one-letter mark (status is a word, not a color) and a legend word.
 * A gap is attention, never green: only a `checked_supported` pass is `pass`.
 */
const LEVEL: Record<Level, { fill: string; mark: string; word: string }> = {
  pass: { fill: "bg-kumo-success text-kumo-inverse", mark: "P", word: "Pass with evidence" },
  fail: { fill: "bg-accent-500 text-kumo-inverse", mark: "F", word: "Fail" },
  gap: { fill: "bg-kumo-warning text-kumo-inverse", mark: "G", word: "Gap (not a pass)" },
  pending: { fill: "bg-tone-300 text-tone-800", mark: "·", word: "Pending" },
  none: { fill: "bg-kumo-faint text-kumo-subtle", mark: "", word: "Not planned" },
};

const LEGEND: Level[] = ["pass", "fail", "gap", "pending", "none"];

const index = (n: number) => String(n).padStart(2, "0");

function cellTitle(item: VerifiedCandidate, kind: string, cell: HeatCell) {
  const head = `${index(item.gridIndex ?? 0)} · ${item.label} · ${kind}`;
  if (cell.verdict === "none") return `${head}: not in the verification plan`;
  const parts = cell.rows.map((r) => {
    const word = statusView(r.verdict === "pending" ? "queued" : r.verdict).label;
    const title = criterion(r, item.budget).title;
    return r.reason ? `${title} ${word} (${REASON_WORDS[r.reason]})` : `${title} ${word}`;
  });
  return `${head}: ${parts.join("; ")}`;
}

/**
 * Heat grid (DESIGN.md 9.5) of check kind (rows) by recent Candidate (columns, oldest left).
 * Square cells with 2px gaps in a fixed 16-column track that scrolls sideways, a mono 9px column
 * index matching the `#` column of the table, a title on every cell and a legend underneath.
 * Each cell links to its Candidate. Fill changes animate over the heat-grid duration.
 */
export function HeatGrid({ items, kinds }: { items: VerifiedCandidate[]; kinds: string[] }) {
  const columns = items
    .filter((i) => i.gridIndex !== null)
    .sort((a, b) => (a.gridIndex ?? 0) - (b.gridIndex ?? 0));
  const slots = Array.from({ length: GRID_COLUMNS }, (_, i) => columns[i]);
  return (
    <div className="grid min-w-0 gap-3">
      <div className="min-w-0 overflow-x-auto">
        <table
          className="border-separate border-spacing-0.5"
          aria-label="Check results by Candidate"
        >
          <thead>
            <tr>
              <th scope="col" className="sr-only">
                Check kind
              </th>
              {slots.map((item, i) => (
                <th
                  // biome-ignore lint/suspicious/noArrayIndexKey: grid slots are positional
                  key={i}
                  scope="col"
                  title={
                    item
                      ? `${index(i + 1)} · ${item.label} · ${truncate(item.change?.goal ?? item.candidate.changeId, 80)}`
                      : `${index(i + 1)} · no Candidate`
                  }
                  className="w-7 p-0 pb-1 text-center align-bottom font-mono text-[9px] font-normal text-kumo-subtle tabular-nums"
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
                  className="max-w-40 truncate pr-3 text-left font-mono text-[11px] font-normal whitespace-nowrap"
                  title={kind}
                >
                  {kind}
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
                          "grid aspect-square size-7 place-items-center font-mono text-[9px] font-semibold",
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
            <span
              aria-hidden
              className={cn(
                "grid size-2.5 place-items-center font-mono text-[7px] leading-none",
                LEVEL[l].fill,
              )}
            />
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
