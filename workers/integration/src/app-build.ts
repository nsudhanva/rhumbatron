import { referencedAssets } from "./acceptance-check.ts";
import type { CheckOutcome } from "./candidate-composer.ts";

/**
 * The app's own build at Candidate composition. An app whose
 * package.json has a `build` script (for example a React client bundled to public/app.js) gets
 * `bun run build` in the Candidate checkout after the ChangeSets merge. The files the build
 * changes go into the Candidate commit, so checks, the preview, and the release serve fresh
 * assets. The `client-assets` check then compares client sources with the served assets.
 */

/** The command the composition step runs. Fixed in code; the script body comes from the app. */
export const APP_BUILD_COMMAND = "bun run build";
/** Hard deadline of the composition build, the same as the `build` check. A miss is a gap. */
export const APP_BUILD_TIMEOUT_MS = 120_000;
/** Directory whose files are always client sources. */
const CLIENT_DIR = "src/client/";
/** Build script files read for their input paths, for example `bun scripts/build.ts`. */
const SCRIPT_FILE = /^(?:\.\/)?([\w-]+(?:\/[\w.-]+)*\.(?:[cm]?[jt]sx?))$/;
/** Source paths named in a build script: string literals under src/. */
const SOURCE_LITERAL = /["'`](?:\.\/)?(src\/[\w./-]+)["'`]/g;

/** The `build` script of package.json, or null when there is none (no build step runs). */
export function appBuildScript(packageJson: string | null): string | null {
  if (!packageJson) return null;
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, unknown> } | null;
    const script = parsed?.scripts?.build;
    return typeof script === "string" && script.trim() ? script.trim() : null;
  } catch {
    return null;
  }
}

/** Files the build script runs (`bun scripts/build.ts` -> `scripts/build.ts`), read for inputs. */
export function buildScriptFiles(script: string): string[] {
  const out: string[] = [];
  for (const token of script.split(/\s+/)) {
    const match = SCRIPT_FILE.exec(token);
    if (match?.[1] && !match[1].split("/").includes("..")) out.push(match[1]);
  }
  return [...new Set(out)].slice(0, 4);
}

/**
 * Source paths a build reads: `src/client/` plus every `src/...` literal in the build script
 * files. A literal file also adds its directory, unless that directory is `src` itself (server
 * code lives there).
 */
export function buildInputs(scriptTexts: readonly string[]): string[] {
  const out = new Set<string>([CLIENT_DIR]);
  for (const text of scriptTexts) {
    for (const match of text.matchAll(SOURCE_LITERAL)) {
      const path = (match[1] ?? "").replace(/\/+$/, "");
      if (!path || path.split("/").includes("..")) continue;
      const last = path.slice(path.lastIndexOf("/") + 1);
      if (!last.includes(".")) {
        if (path !== "src") out.add(`${path}/`);
        continue;
      }
      out.add(path);
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (dir !== "src") out.add(`${dir}/`);
    }
  }
  return [...out].sort();
}

/** True when the build reads the path: inside an input directory, or an input file itself. */
const isClientSource = (path: string, inputs: readonly string[]) =>
  inputs.some((input) => (input.endsWith("/") ? path.startsWith(input) : path === input));

/** Result of the composition build. Only this summary leaves the Sandbox. */
export type AppBuildRun = {
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
  /** The end of the build output. */
  output: string;
  /** Files the build changed, committed on top of the merges. Empty when the build failed. */
  generated: string[];
  startedAt: string;
  completedAt: string;
};

/**
 * Evidence of the composition build for the `build` check. Exit 0 passes. Another exit code is
 * a supported failure. A timeout or a Sandbox error is a gap.
 */
export function appBuildOutcome(run: AppBuildRun): CheckOutcome {
  const tail = run.output.trim().split("\n").slice(-4).join(" | ").slice(-400);
  if (run.timedOut) {
    return {
      status: "error",
      coverage: "not_checked",
      summary: `${APP_BUILD_COMMAND} timed out after ${APP_BUILD_TIMEOUT_MS / 1000} s. A timeout is not a pass.`,
    };
  }
  if (run.exitCode === null || run.error !== undefined) {
    return {
      status: "error",
      coverage: "not_checked",
      summary: `${APP_BUILD_COMMAND} did not run: ${(run.error ?? "no exit code").slice(0, 200)}`,
    };
  }
  if (run.exitCode !== 0) {
    return {
      status: "fail",
      coverage: "checked_supported",
      summary: `${APP_BUILD_COMMAND} failed at composition (exit ${run.exitCode}): ${tail}`.slice(
        0,
        500,
      ),
    };
  }
  return {
    status: "pass",
    coverage: "checked_supported",
    summary: `${APP_BUILD_COMMAND} passed at composition; ${run.generated.length} generated file(s) committed.`,
  };
}

/**
 * The `client-assets` freshness rule. When the Candidate changes a client source (a file the build
 * reads) but no script or style that public/index.html references differs from the base, the live
 * app would serve the old bundle: a supported failure. No changed client source passes. A page
 * without public/index.html, or one that references no local script or style, has no built asset
 * to compare and passes with that summary.
 */
export function clientAssetsOutcome(input: {
  /** Every file that differs between the base commit and the composed commit. */
  changed: readonly string[];
  /** public/index.html of the composed commit, or null. */
  indexHtml: string | null;
  inputs: readonly string[];
}): CheckOutcome {
  const changed = new Set(input.changed);
  const sources = input.changed.filter((p) => isClientSource(p, input.inputs));
  if (sources.length === 0) {
    return {
      status: "pass",
      coverage: "checked_supported",
      summary: "No client source changed; the served assets need no rebuild.",
    };
  }
  const assets = input.indexHtml ? [...new Set(referencedAssets(input.indexHtml))] : [];
  if (assets.length === 0) {
    return {
      status: "pass",
      coverage: "checked_supported",
      summary: input.indexHtml
        ? "public/index.html references no local script or style; no built asset to compare."
        : "No public/index.html; no built asset to compare.",
    };
  }
  const fresh = assets.filter((a) => changed.has(a));
  if (fresh.length > 0) {
    return {
      status: "pass",
      coverage: "checked_supported",
      summary: `${sources.length} client source(s) changed and the build changed ${fresh.join(", ")}.`,
    };
  }
  const shown = sources.slice(0, 3).join(", ") + (sources.length > 3 ? ", ..." : "");
  return {
    status: "fail",
    coverage: "checked_supported",
    summary:
      `Client sources changed (${shown}), but ${assets.join(", ")} referenced by public/index.html ` +
      "did not change after the build: the live app would serve the old bundle.",
  };
}
