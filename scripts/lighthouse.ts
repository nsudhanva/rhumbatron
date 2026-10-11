/**
 * Lighthouse on every page of the UI test matrix (section D), mobile and desktop, against prod.
 * The sign-in page runs signed out; every other page runs signed in as the Clerk prod smoke user.
 * CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID must be set in the environment (prod Clerk instance).
 *
 * Usage: bun run lighthouse [--only=<substring>] [--form=mobile|desktop]
 * Reports: e2e/.lighthouse/<page>-<form>.json. Prints a score table and the failing audits.
 *
 * Chrome comes from Playwright's Chromium (bunx playwright install chromium). Lighthouse runs
 * with disableStorageReset so the session cookies survive between runs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";
import desktopConfig from "lighthouse/core/config/desktop-config.js";
import { signInPage } from "../e2e/ui/clerk.ts";
import { PAGES } from "../e2e/ui/support.ts";

const BASE = "https://rhumbatron.com";
const OUT = "e2e/.lighthouse";
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"] as const;

if (!process.env.CLERK_SECRET_KEY || !process.env.CLERK_SMOKE_USER_ID) {
  console.error("CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID are required (prod Clerk instance).");
  process.exit(2);
}
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
const formArg = process.argv.find((a) => a.startsWith("--form="))?.slice(7);
const forms = (formArg ? [formArg] : ["mobile", "desktop"]) as ("mobile" | "desktop")[];

type Row = { page: string; form: string; scores: Record<string, number | null>; failing: string[] };

const pages = [
  { name: "Sign-in (signed out)", path: "/sign-in", signedOut: true },
  ...PAGES.filter((p) => !p.path.includes("#")).map((p) => ({ ...p, signedOut: false })),
].filter((p) => !only || p.name.toLowerCase().includes(only.toLowerCase()));

mkdirSync(OUT, { recursive: true });
const chrome = await chromeLauncher.launch({
  chromePath: chromium.executablePath(),
  chromeFlags: [
    "--headless=new",
    "--no-first-run",
    // Local DNS blocks the Cloudflare analytics beacon on this machine.
    "--host-resolver-rules=MAP static.cloudflareinsights.com 104.16.80.73",
  ],
});

const rows: Row[] = [];
let signedIn = false;
try {
  for (const p of pages) {
    if (!p.signedOut && !signedIn) {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${chrome.port}`);
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = await context.newPage();
      await signInPage(page, BASE);
      await page.close();
      await browser.close();
      signedIn = true;
    }
    for (const form of forms) {
      const result = await lighthouse(
        `${BASE}${p.path}`,
        {
          port: chrome.port,
          output: "json",
          logLevel: "error",
          onlyCategories: [...CATEGORIES],
          // Keep the Clerk session between runs.
          disableStorageReset: !p.signedOut,
        },
        form === "desktop" ? desktopConfig : undefined,
      );
      if (!result) throw new Error(`no Lighthouse result for ${p.path}`);
      const lhr = result.lhr;
      const slug = `${p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${form}`;
      writeFileSync(`${OUT}/${slug}.json`, JSON.stringify(lhr));
      const scores = Object.fromEntries(
        CATEGORIES.map((c) => [c, lhr.categories[c]?.score ?? null] as const),
      ) as Record<string, number | null>;
      const failing = CATEGORIES.flatMap((c) =>
        (lhr.categories[c]?.auditRefs ?? [])
          .filter((ref) => ref.weight > 0)
          .map((ref) => lhr.audits[ref.id])
          .filter(
            (a): a is NonNullable<typeof a> =>
              !!a &&
              a.score !== null &&
              a.score < 1 &&
              (a.scoreDisplayMode === "binary" ||
                a.scoreDisplayMode === "metricSavings" ||
                a.scoreDisplayMode === "numeric"),
          )
          .map((a) => `${c.slice(0, 4)}:${a.id}${a.displayValue ? ` (${a.displayValue})` : ""}`),
      );
      if (
        lhr.finalDisplayedUrl &&
        new URL(lhr.finalDisplayedUrl).pathname !== p.path.split("?")[0]
      ) {
        failing.unshift(`redirected to ${new URL(lhr.finalDisplayedUrl).pathname}`);
      }
      rows.push({ page: p.name, form, scores, failing });
      const fmt = (v: number | null | undefined) =>
        v == null ? " —" : String(Math.round(v * 100)).padStart(3);
      console.log(
        `${p.name.padEnd(22)} ${form.padEnd(7)} ${CATEGORIES.map((c) => fmt(scores[c])).join(" ")}  ${failing.join(", ")}`,
      );
    }
  }
} finally {
  await chrome.kill();
}

console.log("\nPage                   Form     Perf A11y BP  SEO");
for (const r of rows) {
  const fmt = (v: number | null | undefined) =>
    v == null ? "  —" : String(Math.round(v * 100)).padStart(4);
  console.log(
    `${r.page.padEnd(22)} ${r.form.padEnd(7)} ${CATEGORIES.map((c) => fmt(r.scores[c])).join(" ")}`,
  );
}
writeFileSync(`${OUT}/summary.json`, JSON.stringify(rows, null, 2));
const imperfect = rows.filter((r) => CATEGORIES.some((c) => (r.scores[c] ?? 0) < 1));
process.exit(imperfect.length > 0 ? 1 : 0);
