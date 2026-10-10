import { z } from "zod";

export type AppCheckKind = "build" | "unit" | "contract";
export type AppCheckResult = {
  kind: AppCheckKind;
  status: "pass" | "fail" | "error" | "skipped";
  coverage: "checked_supported" | "not_checked";
  /** False permits Sandbox fallback. A completed assertion failure must not be retried as a pass. */
  supported: boolean;
  summary: string;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  passed: number;
  failed: number;
  failures: { name: string; message: string }[];
  startedAt: string;
  completedAt: string;
};

const UnitReport = z
  .object({
    passed: z.number().int().min(0).max(1000),
    failed: z.number().int().min(0).max(1000),
    failures: z
      .array(z.object({ name: z.string().max(300), message: z.string().max(1000) }))
      .max(1000),
    unsupported: z.array(z.string().max(1000)).max(1000),
  })
  .refine((r) => r.failed === r.failures.length && r.passed + r.failed <= 1000);

export function checkGap(kind: AppCheckKind, summary: string, timedOut = false): AppCheckResult {
  return {
    kind,
    status: "error",
    coverage: "not_checked",
    supported: false,
    summary: summary.slice(0, 1000),
    exitCode: null,
    output: "",
    timedOut,
    passed: 0,
    failed: 0,
    failures: [],
    startedAt: "",
    completedAt: "",
  };
}

/** Only a completed positive result can satisfy a required check (AGENTS.md 34.4.1). */
export function mapCheckResult(kind: AppCheckKind, reports: unknown[]): AppCheckResult {
  const result = checkGap(kind, "No completed check result.");
  if (!reports.length) return result;
  if (kind === "unit") {
    for (const report of reports) {
      const parsed = UnitReport.safeParse(report);
      if (!parsed.success) return checkGap(kind, "Invalid test report.");
      const data = parsed.data;
      result.passed += data.passed;
      result.failed += data.failed;
      result.failures.push(...data.failures);
      if (data.unsupported.length) {
        result.summary = `Unsupported test API: ${data.unsupported.join("; ")}`.slice(0, 1000);
        return result;
      }
      if (data.passed + data.failed === 0) {
        result.summary = "A test file registered no tests. Missing tests are a gap.";
        return result;
      }
    }
    result.supported = true;
    result.status = result.failed ? "fail" : "pass";
    result.coverage = result.failed ? "not_checked" : "checked_supported";
    result.exitCode = result.failed ? 1 : 0;
    result.summary = `${result.passed} pass, ${result.failed} fail`;
    result.output = JSON.stringify({
      passed: result.passed,
      failed: result.failed,
      failures: result.failures,
    });
    return result;
  }
  if (kind === "contract") {
    const table = z
      .object({ routes: z.array(z.string().regex(/^[A-Z]+ \/[^\r\n]*$/)).max(2000) })
      .safeParse(reports[0]);
    if (!table.success) return checkGap(kind, "No valid Hono route table.");
    result.output = JSON.stringify({ routes: [...new Set(table.data.routes)].sort() });
    result.summary = `${table.data.routes.length} routes extracted; the workflow must compare with the base.`;
  } else {
    if (!z.object({ loaded: z.literal(true) }).safeParse(reports[0]).success) return result;
    result.output = JSON.stringify({ loaded: true });
    result.summary = "Bundle succeeded and the entry module loaded.";
  }
  return { ...result, supported: true, status: "pass", coverage: "checked_supported", exitCode: 0 };
}
