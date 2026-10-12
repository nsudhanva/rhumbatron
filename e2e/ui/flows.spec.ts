/// <reference lib="dom" />
import { apiFetch } from "./clerk";
import { evidence, expect, open, settle, test } from "./support";

/**
 * Flows that write (C1, C3 form, C4 states, C6 Code save and Settings rename). They run once,
 * on desktop, in order, on a fresh Project `e2e-ui-<ts>` that the last step deletes. Model
 * spend: one intake call for the unclear request and the planning that its answers start,
 * cancelled as soon as the Change runs.
 */
test.describe.configure({ mode: "serial" });

const ts = Date.now().toString(36);
const NAME = `e2e-ui-${ts}`;
const SLUG = `e2e-ui-${ts}`;
let projectId = "";

test.describe("@desktop-only writes on a fresh Project", () => {
  // Delete this run's Project and any `e2e-ui-*` Project an earlier, interrupted run left.
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage({ storageState: "e2e/.auth/smoke.json" });
    await page.goto("/");
    const res = await apiFetch(page, "/v1/projects?limit=200");
    const list = ((await res.json()) as { data: { id: string; slug: string; status: string }[] })
      .data;
    for (const p of list) {
      if (p.status === "active" && /^e2e-ui-[a-z0-9]+$/.test(p.slug)) {
        const del = await apiFetch(page, `/v1/projects/${p.id}`, { method: "DELETE" });
        process.stdout.write(`cleanup: DELETE ${p.slug} ${del.status}\n`);
      }
    }
    await page.close();
  });

  test("C1 home: list, inline validation, create, open", async ({ page }, info) => {
    await open(page, "/");
    await expect(page.getByRole("table", { name: "Projects" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Todo check/ })).toBeVisible();

    const name = page.getByRole("textbox", { name: "Name" });
    const slug = page.getByRole("textbox", { name: "Slug" });
    const create = page.getByRole("button", { name: "Create project" });
    await create.click();
    await expect(page.getByText("Enter a name.")).toBeVisible();
    await expect(page.getByText("Enter a slug, for example my-app.")).toBeVisible();
    await slug.fill("Bad Slug");
    await expect(page.getByText("Use lowercase kebab-case, for example my-app")).toBeVisible();
    await evidence(page, info, "create-validation");

    await name.fill(NAME);
    await slug.fill(SLUG);
    await create.click();
    await page.waitForURL(/\/projects\/proj_[0-9a-f-]+$/, { timeout: 60_000 });
    projectId = /\/projects\/(proj_[0-9a-f-]+)/.exec(page.url())?.[1] ?? "";
    expect(projectId).not.toBe("");
    await settle(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(NAME);
  });

  test("C6 settings: rename, then rename back", async ({ page }) => {
    test.skip(!projectId, "no Project");
    await open(page, `/projects/${projectId}/settings`);
    const name = page.getByRole("textbox", { name: "Name" });
    await expect(name).toHaveValue(NAME);
    await expect(page.getByText("No changes to save.")).toBeVisible();
    await name.fill(`${NAME} renamed`);
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    // The sidebar follows the new name.
    await expect(page.locator("aside").getByText(`${NAME} renamed`)).toBeVisible();
    await name.fill(NAME);
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await expect(page.locator("aside").getByText(NAME, { exact: true })).toBeVisible();
  });

  test("C6 code: CodeMirror edit, Save creates a Change, then cancel it", async ({ page }) => {
    test.skip(!projectId, "no Project");
    await open(page, `/projects/${projectId}/code`);
    const files = page
      .locator("#content")
      .getByRole("button")
      .filter({ hasText: /\.\w+$/ });
    if ((await files.count()) === 0) {
      test.skip(true, "a new Project has no files to edit");
    }
    await files.first().click();
    // "Edit" edits the open file; "Start editing" opens an edit session of the whole Project.
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.locator(".cm-content");
    await expect(editor).toBeVisible();
    // Save with no edit explains why.
    await page.getByRole("button", { name: "Save change" }).click();
    await expect(
      page.getByText(/Nothing to save: the file matches the live version/),
    ).toBeVisible();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("\n// e2e-ui edit\n");
    await page.getByRole("button", { name: "Save change" }).click();
    await page.waitForURL(/\/changes\/chg_/, { timeout: 60_000 });
    await settle(page);
    await page.getByRole("button", { name: "Cancel change" }).click();
    await page.getByRole("button", { name: "Confirm cancel" }).click();
    await expect(page.getByText(/^Cancelled$/).first()).toBeVisible({ timeout: 60_000 });
  });

  test("C4 needs_input: answer form, running, cancelled", async ({ page }, info) => {
    test.skip(!projectId, "no Project");
    test.setTimeout(240_000);
    await open(page, `/projects/${projectId}`);
    await page.getByRole("textbox", { name: "Goal" }).fill("make it better");
    await page.getByRole("button", { name: "Submit change" }).click();
    await page.waitForURL(/\/changes\/chg_/, { timeout: 60_000 });
    await settle(page);
    await evidence(page, info, "compiling");

    // Intake asks: the answer form appears.
    const send = page.getByRole("button", { name: "Send answers" });
    await expect(send).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText("Waiting for your answer").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Build it as it is" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Withdraw request" })).toBeVisible();
    await evidence(page, info, "needs-input");

    await send.click();
    await expect(
      page.getByText('Answer every question, or choose "Build it as it is".'),
    ).toBeVisible();
    const answers = page.locator("form textarea");
    const n = await answers.count();
    for (let i = 0; i < n; i++) {
      await answers.nth(i).fill("A single page that shows the text Hello. Nothing else.");
    }
    await send.click();
    await expect(send).toBeHidden({ timeout: 60_000 });

    // It leaves needs_input; cancel before a build spends money.
    const cancel = page.getByRole("button", { name: "Cancel change" });
    await expect(cancel).toBeVisible({ timeout: 60_000 });
    await evidence(page, info, "running");
    await cancel.click();
    await page.getByRole("button", { name: "Confirm cancel" }).click();
    await expect(page.getByText(/^Cancelled$/).first()).toBeVisible({ timeout: 60_000 });
    await expect(cancel).toBeHidden();
  });

  test("C4 approval dialog on an awaiting-approval Candidate, if one exists", async ({ page }) => {
    await open(page, "/");
    const res = await apiFetch(page, "/v1/projects?limit=50");
    const projects = ((await res.json()) as { data: { id: string }[] }).data;
    let candidateId: string | null = null;
    for (const p of projects) {
      const changes = (await (await apiFetch(page, `/v1/projects/${p.id}/changes`)).json()) as {
        data: { id: string; status: string }[];
      };
      const waiting = changes.data.find((c) => c.status === "awaiting_approval");
      if (!waiting) continue;
      const cands = (await (
        await apiFetch(page, `/v1/changes/${waiting.id}/candidates`)
      ).json()) as {
        data: { id: string; status: string; approvalRequired?: boolean }[];
      };
      candidateId = cands.data.find((c) => c.status === "verified")?.id ?? null;
      if (candidateId) break;
    }
    test.skip(
      !candidateId,
      "no Candidate awaits approval for the smoke user (needs a high-risk build)",
    );
    await open(page, `/candidates/${candidateId}`);
    await page.getByRole("button", { name: "Review and approve" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/required/i).first()).toBeVisible();
    // Close without deciding: the API journey owns the decision.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("C6 settings: delete the Project with the typed name", async ({ page }) => {
    test.skip(!projectId, "no Project");
    await open(page, `/projects/${projectId}/settings`);
    await page.getByRole("button", { name: "Delete project" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Delete project" }).click();
    await expect(dialog.getByText(/The name does not match/)).toBeVisible();
    await dialog.getByRole("textbox").fill(NAME);
    await dialog.getByRole("button", { name: "Delete project" }).click();
    await page.waitForURL((u) => u.pathname === "/", { timeout: 60_000 });
    await settle(page);
    await expect(page.getByRole("link", { name: new RegExp(NAME) })).toHaveCount(0);
  });
});
