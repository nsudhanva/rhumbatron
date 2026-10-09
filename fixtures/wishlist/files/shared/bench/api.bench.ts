/**
 * API benchmark. Runs each endpoint benchmark in its own process and prints the slowest
 * endpoint's p95 as the API p95: {"p95Ms": n, "endpoints": {...}} on the last line.
 */
const BENCHES: readonly [string, string][] = [
  ["GET /api/cart", "bench/cart.bench.ts"],
  ["wishlist API", "bench/wishlist.bench.ts"],
];

const endpoints: Record<string, number> = {};
for (const [name, file] of BENCHES) {
  const run = Bun.spawnSync([process.execPath, "run", file], { stdout: "pipe", stderr: "inherit" });
  const line = run.stdout
    .toString()
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("{"));
  const p95 = line ? (JSON.parse(line) as { p95Ms?: unknown }).p95Ms : undefined;
  if (run.exitCode !== 0 || typeof p95 !== "number") {
    console.error(`${file} failed (exit ${run.exitCode}); no p95 for ${name}`);
    process.exit(1);
  }
  endpoints[name] = p95;
  process.stdout.write(`${JSON.stringify({ endpoint: name, endpointP95Ms: p95 })}\n`);
}

const p95Ms = Math.max(...Object.values(endpoints));
process.stdout.write(`${JSON.stringify({ p95Ms, endpoints })}\n`);
