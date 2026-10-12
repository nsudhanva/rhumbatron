/// <reference lib="dom" />
import { evidence, expect, horizontalOverflow, isNarrow, open, TODO, test } from "./support";

/** The Board, roles in Settings, and a proposed request, on the read-only "Todo check" fixture. */
const P = `/projects/${TODO.project}`;
const COLUMNS = ["Proposed", "Needs answer", "Building", "Checking", "Shipped", "Not built"];

test("Board: columns, lanes, By person and By stage", async ({ page }, info) => {
  await open(page, `${P}/board`);
  await expect(page.getByRole("heading", { name: "Board", level: 1 })).toBeVisible();
  const board = page.getByTestId("board");
  for (const column of COLUMNS) {
    // The column heading reads "<Stage> <count>" once the board loads.
    await expect(
      board.getByRole("heading", { name: new RegExp(`^${column}( \\d+)?$`) }),
    ).toBeAttached();
  }
  const view = page.getByRole("group", { name: "Board view" });
  await expect(view.getByRole("button", { name: "By person" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // By person: one lane per person; the smoke user (the owner) has a lane of their own.
  await expect(board.getByRole("region", { name: "Requests of You" })).toBeVisible();

  await view.getByRole("button", { name: "By stage" }).click();
  await expect(view.getByRole("button", { name: "By stage" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(board.getByRole("region", { name: "All requests" })).toBeVisible();
  await expect(board.getByRole("region", { name: /^Requests of / })).toHaveCount(0);

  // The fixture has Changes: every card links to its Change.
  const card = board.getByTestId("board-card").first();
  await expect(card).toBeVisible();
  await expect(card.getByRole("link")).toHaveAttribute("href", /\/changes\/chg_/);
  await evidence(page, info, "board-by-stage");

  // Phone width: the columns scroll inside the board, never the page.
  if (isNarrow(page)) {
    const overflow = await horizontalOverflow(page);
    expect(overflow).toEqual({ document: 0, content: 0 });
    expect(await board.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  }
});

test("Board: person filter narrows to one lane", async ({ page }) => {
  await open(page, `${P}/board`);
  const filter = page.getByRole("combobox", { name: "Person" });
  test.skip(!(await filter.isVisible()), "The fixture project has one person: no filter shows.");
  await filter.click();
  const options = page.getByRole("option");
  await expect(options.first()).toBeVisible();
  await options.nth(1).click();
  await expect(
    page.getByTestId("board").getByRole("region", { name: /^Requests of / }),
  ).toHaveCount(1);
});

test("Settings: roles on people, member review default", async ({ page }) => {
  await open(page, `${P}/settings`);
  const people = page.locator("section", {
    has: page.getByRole("heading", { name: "People", exact: true }),
  });
  // The smoke user owns the fixture: its row reads Owner and You.
  await expect(people.getByText("Owner", { exact: true }).first()).toBeVisible();
  await expect(people.getByText("You", { exact: true }).first()).toBeVisible();
  // The owner invites with a role.
  await expect(people.getByRole("combobox", { name: "Role of the invited person" })).toBeVisible();
  const review = page.getByRole("group", { name: "Member requests need review" });
  await expect(review).toBeVisible();
  await expect(review.locator("button[aria-pressed='true']")).toHaveCount(1);
});

test("Change: a proposed request shows the review state", async ({ page }) => {
  await open(page, `${P}/board`);
  const proposed = page
    .getByTestId("board")
    .locator("[data-column='proposed']")
    .getByTestId("board-card");
  test.skip((await proposed.count()) === 0, "No proposed request on the fixture project.");
  await proposed.first().getByRole("link").first().click();
  await expect(page.getByText("Waiting for an admin to include it").first()).toBeVisible();
  // The owner reviews: Include and Decline are the actions in Needs attention.
  await expect(page.getByRole("button", { name: /^Include: / })).toBeVisible();
  await page.getByRole("button", { name: /^Decline: / }).click();
  await expect(page.getByRole("textbox", { name: "Reason (optional)" })).toBeVisible();
  await page.getByRole("button", { name: "Keep it" }).click();
});
