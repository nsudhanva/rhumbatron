/// <reference lib="dom" />
import { evidence, expect, open, REAL, TODO, test } from "./support";

/** C4 (states on fixtures) and C5 (Candidate, compare one and several). Read-only. */
test.describe("Change page", () => {
  test("completed: Live as Sn, open live app, Flight Control, disclosures", async ({
    page,
  }, info) => {
    await open(page, `/changes/${TODO.change}`);
    await expect(page.getByText("Done", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/^Live as S\d+$/)).toBeVisible();
    const liveApp = page.getByRole("link", { name: "Open live app" });
    await expect(liveApp).toHaveAttribute("href", new RegExp(TODO.app.replace("https://", "")));
    // Completed: nothing to cancel.
    await expect(page.getByRole("button", { name: "Cancel change" })).toHaveCount(0);

    // Every closed Details disclosure opens and closes.
    const triggers = page.locator("#content button[aria-expanded='false']");
    const count = await triggers.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const t = triggers.first();
      const label = (await t.innerText()).split("\n")[0];
      await t.click();
      await expect(
        page
          .locator("#content button[aria-expanded='true']")
          .filter({ hasText: label ?? "" })
          .first(),
      ).toBeVisible();
    }
    await evidence(page, info, "change-completed");

    await page.getByRole("link", { name: "Open Flight Control" }).click();
    await expect(page).toHaveURL(new RegExp(`/changes/${TODO.change}/flight`));
  });

  test("withdrawn duplicate: cancelled with the outcome reason", async ({ page }) => {
    await open(page, `/changes/${REAL.withdrawnDuplicate}`);
    await expect(page.getByText(/Cancelled|Withdrawn/).first()).toBeVisible();
    await expect(page.getByText(/Withdrawn by the requester/).first()).toBeVisible();
    // A withdrawn request has no answer form and no Cancel.
    await expect(page.getByRole("button", { name: "Send answers" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancel change" })).toHaveCount(0);
  });

  test("withdrawn unclear request shows no live controls", async ({ page }) => {
    await open(page, `/changes/${REAL.withdrawnUnclear}`);
    await expect(page.getByText(/Cancelled|Withdrawn/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Build it as it is" })).toHaveCount(0);
  });
});

test.describe("Candidate and compare", () => {
  test("Candidate page: selection reason, acceptance list, checks, promotion", async ({ page }) => {
    await open(page, `/candidates/${TODO.candidate}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Candidate A/);
    await expect(
      page.getByText(/Promoted · all required checks passed with evidence/),
    ).toBeVisible();
    await expect(page.getByText(/was promoted, S0 → S1/)).toBeVisible();
    const acceptance = page.getByRole("list", { name: "Acceptance criteria" });
    if ((await acceptance.count()) > 0) {
      await expect(acceptance.getByRole("listitem").first()).toBeVisible();
    } else {
      await expect(page.getByRole("heading", { name: /Acceptance criteria/i })).toBeVisible();
    }
    await expect(page.getByText("Required checks met", { exact: false }).first()).toBeVisible();
    // Promoted: no approve, reject or promote button remains.
    for (const name of [/Review and approve/, /^Reject$/, /^Promote S/]) {
      await expect(page.getByRole("button", { name })).toHaveCount(0);
    }
  });

  test("compare with one Candidate explains there is nothing to compare", async ({ page }) => {
    await open(page, `/compare/${TODO.change}`);
    await expect(
      page.getByText(/produced one candidate, so there is nothing to compare/),
    ).toBeVisible();
    await page.getByRole("link", { name: "Open the Candidate" }).click();
    await expect(page).toHaveURL(new RegExp(`/candidates/${TODO.candidate}`));
  });

  test("compare with several Candidates shows the evidence matrix", async ({ page }, info) => {
    await open(page, `/compare/${REAL.change}`);
    await expect(page.getByRole("heading", { name: /Evidence matrix/i })).toBeVisible();
    await expect(page.getByText(/\d+ Evidence records/)).toBeVisible();
    const text = await page.locator("#content").innerText();
    expect(text).toMatch(/Candidate A/);
    expect(text).toMatch(/Candidate B/);
    expect(text).toMatch(/Promoted/i);
    expect(text).toMatch(/Rejected/i);
    await evidence(page, info, "compare-many");
  });
});
