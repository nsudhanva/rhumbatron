/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { evidence, expect, open, TODO, test } from "./support";

/**
 * Replay controller (components/replay) on the timeline and the Agents graph, and the Events
 * filter bar, on the read-only "Todo check" fixture. Nothing here writes.
 */
const P = `/projects/${TODO.project}`;

/** The replay position (epoch ms) of a replay bar. */
const position = (page: Page, bar: string) =>
  page
    .getByRole("group", { name: bar })
    .getByRole("slider", { name: "Replay position" })
    .inputValue()
    .then(Number);

test("Timeline replay: plays, pauses with Space, Live returns", async ({ page }, info) => {
  await open(page, P);
  const bar = page.getByRole("group", { name: "Timeline replay" });
  await expect(bar).toBeVisible();
  const live = bar.getByRole("button", { name: "Live", exact: true });
  await expect(live).toHaveAttribute("aria-pressed", "true");

  await bar.getByRole("button", { name: "Play replay" }).click();
  await expect(bar.getByRole("button", { name: "Pause replay" })).toBeVisible();
  await expect(live).toHaveAttribute("aria-pressed", "false");
  await expect(bar.getByText("Replay", { exact: true })).toBeVisible();
  const first = await position(page, "Timeline replay");
  await expect.poll(() => position(page, "Timeline replay")).toBeGreaterThan(first);

  // The playhead label on the axis and the rail at the playhead.
  const plot = page.locator("section[aria-label='Execution timeline']");
  await expect(plot.locator(".bg-accent-500").first()).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Needs attention" })).toContainText(
    /at \d\d:\d\d:\d\d/,
  );

  // Space pauses (focus in the bar), an arrow steps, L goes live.
  await bar.getByRole("slider", { name: "Replay position" }).focus();
  await page.keyboard.press(" ");
  await expect(bar.getByRole("button", { name: "Play replay" })).toBeVisible();
  const paused = await position(page, "Timeline replay");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => position(page, "Timeline replay")).toBeLessThan(paused);
  await evidence(page, info, "timeline-replay");
  await page.keyboard.press("l");
  await expect(live).toHaveAttribute("aria-pressed", "true");
  await expect(plot.locator(".bg-accent-500")).toHaveCount(0);
});

test("Events filters: the URL and the list follow them, Clear resets", async ({ page }) => {
  await open(page, `${P}/events`);
  const rows = page.locator("tbody [data-seq]");
  await expect(rows.first()).toBeVisible();
  const types = () => page.locator("tbody tr td:nth-child(3)").allInnerTexts();

  const group = page.getByRole("group", { name: "Event type" });
  await group.getByRole("button", { name: /^Planning/ }).click();
  await expect(page).toHaveURL(/[?&]group=planning/);
  await expect
    .poll(async () => (await types()).every((t) => /^(project|change|task)\./.test(t.trim())))
    .toBe(true);

  await page.getByRole("searchbox", { name: "Search" }).fill("change.created");
  await expect(page).toHaveURL(/[?&]q=change\.created/);
  await expect(page.getByText("2 filters", { exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const shown = await types();
      return shown.length > 0 && shown.every((t) => t.trim() === "change.created");
    })
    .toBe(true);
  await expect(page.getByText(/\d+ of \d+ loaded events match the filter/)).toBeVisible();

  // A filtered URL opens filtered.
  await page.reload();
  await expect(page.getByRole("searchbox", { name: "Search" })).toHaveValue("change.created");
  await expect(group.getByRole("button", { name: /^Planning/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Load older keeps the filter.
  const older = page.getByRole("button", { name: "Load older" });
  if (await older.isVisible()) {
    await older.click();
    await expect(page).toHaveURL(/[?&]q=change\.created/);
  }

  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page).not.toHaveURL(/[?&](q|group)=/);
  await expect(page.getByRole("searchbox", { name: "Search" })).toHaveValue("");
  await expect
    .poll(async () => new Set((await types()).map((t) => t.split(".")[0])).size)
    .toBeGreaterThan(1);
});

test("@desktop-only Agents replay: plays and shows the steps", async ({ page }, info) => {
  await open(page, `${P}/agents`);
  const bar = page.getByRole("group", { name: "Agent replay" });
  await expect(bar).toBeVisible();
  await expect(page.getByText("Latest steps")).toBeVisible();

  await bar.getByRole("button", { name: "Play replay" }).click();
  await expect(bar.getByRole("button", { name: "Pause replay" })).toBeVisible();
  await expect(page.getByText("Steps to the playhead")).toBeVisible();
  const first = await position(page, "Agent replay");
  await expect.poll(() => position(page, "Agent replay")).toBeGreaterThan(first);
  // At the first fact only the request is recorded: later nodes wait hidden in their places.
  await bar.getByRole("slider", { name: "Replay position" }).focus();
  await page.keyboard.press("Home");
  await expect(page.locator(".react-flow button[aria-hidden='true']").first()).toBeAttached();
  await evidence(page, info, "agents-replay");

  await bar.getByRole("button", { name: "Live", exact: true }).click();
  await expect(page.getByText("Latest steps")).toBeVisible();
  await expect(page.locator(".react-flow button[aria-hidden='true']")).toHaveCount(0);
});
