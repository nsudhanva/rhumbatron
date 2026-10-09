/**
 * What this page cannot show because nothing records it yet (AGENTS.md section 56: "do not
 * estimate all costs from arbitrary constants"). Those values read `—` or are absent; this
 * footnote names them so a gap never passes for a zero.
 */
const NOT_RECORDED = [
  "cache reads (runs store input and output tokens only)",
  "per-call latency (Analytics Engine only, not queried here)",
  "Sandbox time per Change or Task (the counter is one monthly total)",
  "Browser Run minutes",
  "Workers AI Neurons",
  "Artifact operations",
  "Queue operations",
  "K2 produced and consumed bytes",
  "R2 storage and operations",
];

export function NotRecorded() {
  return (
    <footer className="grid max-w-[760px] gap-1 border-t border-kumo-rule pt-3 text-[11px] text-kumo-subtle">
      <p>
        <span className="font-semibold">Not recorded:</span> {NOT_RECORDED.join(" · ")}.
      </p>
      <p>
        Spend is the sum of recorded attempt cost. Models run on free variants (ADR 0007), so a
        recorded $0.00 is real, and no routing savings are claimed. Call, Clef-flash and Sandbox
        meters are account-wide, across every Project.
      </p>
    </footer>
  );
}
NotRecorded.displayName = "NotRecorded";
