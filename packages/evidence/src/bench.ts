/**
 * Reads the p95 latency from `bun run bench` output (`{"p95Ms": n}` on its own line). The last
 * valid line wins, so tool banners or warnings before it do not matter. Returns null when no line
 * carries a finite, non-negative `p95Ms`; a missing number is never treated as fast.
 */
export function parseBenchOutput(stdout: string): number | null {
  const lines = stdout.split(/\r?\n/).reverse();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try {
      const value = (JSON.parse(line) as { p95Ms?: unknown }).p95Ms;
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    } catch {
      // Not JSON: keep looking at earlier lines.
    }
  }
  return null;
}
