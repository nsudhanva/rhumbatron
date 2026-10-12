import { cn } from "@cloudflare/kumo";

function Line({ className }: { className?: string }) {
  return <span aria-hidden className={cn("skeleton-line block", className)} />;
}

/**
 * First-load skeleton for Candidate pages: recessed lines at the heights of the
 * text they replace, under real rules, so the layout does not jump when data arrives.
 */
export function CandidateSkeleton({ rows = 5, label }: { rows?: number; label: string }) {
  return (
    <div role="status" aria-label={label} className="grid gap-7">
      <div className="grid gap-2">
        <Line className="h-[11px] w-24" />
        <Line className="h-[32px] w-[min(420px,80%)]" />
        <Line className="h-[12px] w-[min(520px,90%)]" />
      </div>
      <div className="flex flex-wrap gap-px border-y-2 border-kumo-divider bg-kumo-rule">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="grid flex-[1_1_180px] gap-2 bg-kumo-base px-4 py-3">
            <Line className="h-[11px] w-20" />
            <Line className="h-[34px] w-16" />
          </div>
        ))}
      </div>
      <div className="grid">
        <div className="border-b-2 border-kumo-divider pb-2">
          <Line className="h-[13px] w-40" />
        </div>
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows are positional
          <div key={i} className="grid gap-1.5 border-b border-kumo-rule py-2.5">
            <Line className="h-[13px] w-[min(360px,70%)]" />
            <Line className="h-[11px] w-[min(520px,90%)]" />
          </div>
        ))}
      </div>
    </div>
  );
}
