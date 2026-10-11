/// <reference lib="dom" />
import { test as base, expect, type Page, type TestInfo } from "@playwright/test";

/** Read-only fixtures the smoke user owns on prod. */
export const TODO = {
  project: "proj_4dcb813d-4d3d-42f3-8dd2-99c52c271d87",
  change: "chg_45f49eca-1fcd-4235-b45c-b38817d33ea4",
  candidate: "cand_dc31a659317dac824aa25e23",
  task: "tsk_45f49eca-1fcd-4235-b45c-b38817d33ea4_t1",
  app: "https://todo-mv497wob.rhumbatron.com",
};
export const REAL = {
  project: "proj_38bfdf81-d057-4899-8fc3-55f9f87dcff0",
  /** Completed Change with one promoted and one rejected Candidate. */
  change: "chg_6a88c890-d236-4c13-a857-9cf738fbd167",
  /** Withdrawn duplicate and withdrawn unclear Changes. */
  withdrawnDuplicate: "chg_e77e566f-c9c5-425c-b648-6e588646acba",
  withdrawnUnclear: "chg_fed9f5e4-bcde-42fc-890c-a702b3d3dc0e",
};

export const PROJECT_PAGES = [
  "graph",
  "agents",
  "events",
  "verification",
  "workspace",
  "code",
  "versions",
  "costs",
  "settings",
] as const;

/** Every signed-in page of the matrix (section C and D), on the read-only fixtures. */
export const PAGES: { name: string; path: string }[] = [
  { name: "Home", path: "/" },
  { name: "Project overview", path: `/projects/${TODO.project}` },
  { name: "Changes", path: `/projects/${TODO.project}#changes` },
  { name: "Change", path: `/changes/${TODO.change}` },
  { name: "Change (withdrawn)", path: `/changes/${REAL.withdrawnUnclear}` },
  { name: "Candidate", path: `/candidates/${TODO.candidate}` },
  { name: "Compare (one)", path: `/compare/${TODO.change}` },
  { name: "Compare (many)", path: `/compare/${REAL.change}` },
  { name: "Flight Control", path: `/changes/${TODO.change}/flight` },
  ...PROJECT_PAGES.map((p) => ({
    name: p[0]?.toUpperCase() + p.slice(1),
    path: `/projects/${TODO.project}/${p}`,
  })),
];

/** Console errors, page errors and failed same-site requests seen by one test. */
export type Problems = { console: string[]; network: string[] };

export const test = base.extend<{ problems: Problems }>({
  problems: async ({ page }, use) => {
    const problems: Problems = { console: [], network: [] };
    page.on("console", (m) => {
      if (m.type() === "error") problems.console.push(`${m.text()} @ ${m.location().url}`);
    });
    page.on("pageerror", (e) => problems.console.push(`pageerror: ${e.message}`));
    page.on("response", (r) => {
      const url = r.url();
      if (r.status() >= 400 && /rhumbatron\.com/.test(new URL(url).hostname)) {
        problems.network.push(`${r.status()} ${r.request().method()} ${url}`);
      }
    });
    page.on("requestfailed", (r) => {
      const err = r.failure()?.errorText ?? "";
      // Navigations away abort in-flight fetches and sockets; that is not a fault.
      if (err === "net::ERR_ABORTED") return;
      problems.network.push(`failed ${r.method()} ${r.url()} ${err}`);
    });
    await use(problems);
  },
});
export { expect };

/** Opens a page and waits until its h1 shows and the network settles. */
export async function open(page: Page, path: string) {
  await page.goto(path);
  await settle(page);
}

export async function settle(page: Page) {
  await expect(page.locator("h1").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  // Skeletons (aria-busy) and loading placeholders ("Loading Change") must be gone.
  await expect(page.locator("#content [aria-busy='true']")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(/^Loading (Change|the project)$/)).toHaveCount(0, {
    timeout: 20_000,
  });
}

/** Whether the narrow layout is active (the sidebar collapses under 720px). */
export const isNarrow = (page: Page) => (page.viewportSize()?.width ?? 1440) < 720;

/** Opens the narrow-screen menu when needed so the sidebar links are clickable. */
export async function showNav(page: Page) {
  if (!isNarrow(page)) return;
  // The menu closes itself when the route context settles; retry until it stays open.
  await expect(async () => {
    const toggle = page.getByRole("button", { name: "Open menu" });
    if (await toggle.isVisible()) await toggle.click();
    await expect(page.locator("#shell-nav")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/**
 * C9: every visible disabled control must carry a reason: a title, an aria-describedby that
 * resolves to text, or reason text next to it (in its parent group, beside its own label).
 */
export async function disabledWithoutReason(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const sel =
      "button:disabled, input:disabled, select:disabled, textarea:disabled, [aria-disabled='true']";
    for (const node of document.querySelectorAll(sel)) {
      const el = node as HTMLElement;
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      // A Kumo Button in a loading state is disabled while it shows a spinner.
      if (el.querySelector("[role='status'], .animate-spin")) continue;
      const own = (el.innerText || el.getAttribute("aria-label") || "").trim();
      if (el.getAttribute("title")?.trim()) continue;
      const described = (el.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
        .join("");
      if (described) continue;
      // Kumo wraps a titled Button in a tooltip trigger span: look one level above it.
      const anchor = el.parentElement?.hasAttribute("data-base-ui-tooltip-trigger")
        ? el.parentElement
        : el;
      const group = anchor.parentElement;
      const around = (group?.innerText ?? "").replace(own, "").trim();
      if (around.length > 2) continue;
      out.push(`${el.tagName.toLowerCase()} "${own.slice(0, 50)}"`);
    }
    return out;
  });
}

/** C9 at 412px: neither the document nor the scrolling main column scrolls sideways. */
export async function horizontalOverflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.scrollingElement as HTMLElement;
    const content = document.getElementById("content");
    return {
      document: doc.scrollWidth - doc.clientWidth,
      content: content ? content.scrollWidth - content.clientWidth : 0,
    };
  });
}

/** Attaches a screenshot to the report (evidence for a pass or a fail). */
export async function evidence(page: Page, info: TestInfo, name: string) {
  await info.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}
