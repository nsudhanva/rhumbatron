import { cn } from "@cloudflare/kumo";

function Line({ className }: { className?: string }) {
  return <span aria-hidden className={cn("skeleton-line block rounded", className)} />;
}

/**
 * First-load skeleton for version pages: lines at the heights of the text they replace, inside
 * the same cards, so the layout does not jump when data arrives.
 */
export function CandidateSkeleton({ rows = 5, label }: { rows?: number; label: string }) {
  return (
    <div role="status" aria-label={label} className="grid gap-7">
      <div className="grid gap-2">
        <Line className="h-[32px] w-[min(420px,80%)]" />
        <Line className="h-[12px] w-[min(520px,90%)]" />
      </div>
      <div className="rounded-lg border border-kumo-rule bg-kumo-elevated px-4 py-3">
        <Line className="h-[14px] w-[min(560px,90%)]" />
      </div>
      <div className="grid gap-3">
        <Line className="h-[14px] w-40" />
        <div className="grid rounded-lg border border-kumo-rule bg-kumo-elevated">
          {Array.from({ length: rows }, (_, i) => `row-${i}`).map((id) => (
            <div
              key={id}
              className="grid gap-1.5 border-b border-kumo-rule px-3 py-2.5 last:border-b-0"
            >
              <Line className="h-[14px] w-[min(360px,70%)]" />
              <Line className="h-[12px] w-[min(520px,90%)]" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
CandidateSkeleton.displayName = "CandidateSkeleton";
