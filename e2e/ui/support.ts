/// <reference lib="dom" />
import { test as base, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { apiFetch } from "./clerk";

/** Read-only fixtures the smoke user owns on prod. */
export const TODO = {
  project: "proj_4dcb813d-4d3d-42f3-8dd2-99c52c271d87",
  change: "chg_45f49eca-1fcd-4235-b45c-b38817d33ea4",
  candidate: "cand_dc31a659317dac824aa25e23",
  task: "tsk_45f49eca-1fcd-4235-b45c-b38817d33ea4_t1",
  app: "https://todo-mv497wob.rhumbatron.com",
};

/**
 * Fixtures found at run time in the Projects the smoke user can open, because a request that
 * ended a certain way cannot be made on demand. A spec skips with a reason when none exists.
 */
export type FixtureKey = "withdrawnDuplicate" | "withdrawnUnclear" | "compareMany";
export const FIXTURE_ABOUT: Record<FixtureKey, string> = {
  withdrawnDuplicate: "a Change withdrawn as a duplicate by its requester",
  withdrawnUnclear: "a Change withdrawn as unclear before planning",
  compareMany: "a Change with a promoted and a rejected Candidate",
};

type ChangeRow = {
  id: string;
  status: string;
  taskCount: number;
  clarification: { kind: string } | null;
};
let found: Promise<Partial<Record<FixtureKey, string>>> | undefined;

async function data<T>(page: Page, path: string): Promise<T> {
  const response = await apiFetch(page, path);
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}`);
  return ((await response.json()) as { data: T }).data;
}

async function search(page: Page): Promise<Partial<Record<FixtureKey, string>>> {
  if (!page.url().startsWith("http")) await page.goto("/");
  const out: Partial<Record<FixtureKey, string>> = {};
  const projects = await data<{ id: string; name: string }[]>(page, "/v1/projects?limit=50");
  // Projects named e2e-* belong to write flows that delete them during the run.
  for (const project of projects.filter((p) => !p.name.startsWith("e2e-"))) {
    const changes = await data<ChangeRow[]>(page, `/v1/projects/${project.id}/changes`);
    for (const change of changes) {
      const kind = change.clarification?.kind;
      if (change.status === "cancelled" && kind === "duplicate" && !out.withdrawnDuplicate) {
        const detail = JSON.stringify(await data<unknown>(page, `/v1/changes/${change.id}`));
        if (detail.includes("Withdrawn by the requester")) out.withdrawnDuplicate = change.id;
      }
      if (
        change.status === "cancelled" &&
        kind === "unclear" &&
        change.taskCount === 0 &&
        !out.withdrawnUnclear
      ) {
        out.withdrawnUnclear = change.id;
      }
      if (change.status === "completed" && !out.compareMany) {
        const candidates = await data<{ status: string }[]>(
          page,
          `/v1/changes/${change.id}/candidates`,
        );
        const statuses = new Set(candidates.map((c) => c.status));
        if (statuses.has("promoted") && statuses.has("rejected")) out.compareMany = change.id;
      }
    }
  }
  return out;
}

/** The ID of a run-time fixture, or undefined when no Project of the smoke user has one. */
export async function findFixture(page: Page, key: FixtureKey): Promise<string | undefined> {
  found ??= search(page).catch((error: unknown) => {
    found = undefined;
    throw error;
  });
  return (await found)[key];
}

/**
 * Resolves a `{fixture}` placeholder in a matrix path. Skips the test with the reason when no
 * such fixture exists.
 */
export async function resolvePath(page: Page, path: string): Promise<string> {
  const match = /\{(\w+)\}/.exec(path);
  if (!match) return path;
  const key = match[1] as FixtureKey;
  const id = await findFixture(page, key);
  test.skip(!id, `No Project of the smoke user has ${FIXTURE_ABOUT[key]}.`);
  return path.replace(match[0], id ?? "");
}

const PROJECT_PAGES = [
  "board",
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

/**
 * Every signed-in page of the matrix (section C and D), on the read-only fixtures. A `{key}` in a
 * path is a run-time fixture (`resolvePath`).
 */
export const PAGES: { name: string; path: string }[] = [
  { name: "Home", path: "/" },
  { name: "Project overview", path: `/projects/${TODO.project}` },
  { name: "Changes", path: `/projects/${TODO.project}#changes` },
  { name: "Change", path: `/changes/${TODO.change}` },
  { name: "Change (withdrawn)", path: "/changes/{withdrawnUnclear}" },
  { name: "Candidate", path: `/candidates/${TODO.candidate}` },
  { name: "Compare (one)", path: `/compare/${TODO.change}` },
  { name: "Compare (many)", path: "/compare/{compareMany}" },
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

/**
 * Waits until React owns a server-rendered control, so a click reaches its handler. A click
 * before hydration lands on the server HTML and does nothing.
 */
export async function hydrated(control: Locator) {
  await expect
    .poll(() => control.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps"))))
    .toBe(true);
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
