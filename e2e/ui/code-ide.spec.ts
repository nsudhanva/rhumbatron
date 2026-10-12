/// <reference lib="dom" />
import { evidence, expect, horizontalOverflow, isNarrow, open, TODO, test } from "./support";

/**
 * Code page edit sessions on the "Todo check" fixture, which the smoke user owns. Browse mode
 * writes nothing. The session test opens a real session (a fork and Sandbox time), so it runs
 * only with E2E_SESSIONS=1; it discards the session at the end, so canonical code never changes.
 */
const P = `/projects/${TODO.project}`;

test("Code IDE: browse mode loads without the IDE; the owner sees Start editing", async ({
  page,
}, info) => {
  const ideRequests: string[] = [];
  page.on("request", (r) => {
    if (/code-ide/.test(r.url())) ideRequests.push(r.url());
  });
  await open(page, `${P}/code`);
  await expect(page.getByRole("heading", { name: "Code", level: 1 })).toBeVisible();
  await expect(page.getByRole("list", { name: "Canonical files" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start editing" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Edit session" })).toHaveCount(0);
  // The IDE module loads only when a session starts.
  expect(ideRequests).toEqual([]);
  if (isNarrow(page)) {
    expect(await horizontalOverflow(page)).toEqual({ document: 0, content: 0 });
  }
  await evidence(page, info, "code-browse");
});

test("Code IDE session: open, edit and save a file, run ls, discard @desktop-only", async ({
  page,
}, info) => {
  test.skip(process.env.E2E_SESSIONS !== "1", "Sessions use Sandbox time; set E2E_SESSIONS=1");
  test.setTimeout(240_000);
  await open(page, `${P}/code`);
  await page.getByRole("button", { name: "Start editing" }).click();
  await expect(page).toHaveURL(/edit=/);
  const ide = page.getByRole("region", { name: "Edit session" });
  await expect(ide).toBeVisible();
  const tree = ide.getByRole("list", { name: "Session files" });
  await expect(tree).toBeVisible({ timeout: 60_000 });

  // Open a file from the tree, edit it, and save with Cmd/Ctrl+S.
  await tree
    .getByRole("button", { name: /app\.ts/ })
    .first()
    .click();
  const editor = ide.locator("[role='tabpanel']:not([hidden]) .cm-editor");
  await expect(editor).toBeVisible();
  await editor.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n// e2e session edit\n");
  await expect(ide.getByRole("tab", { name: /app\.ts.*unsaved/ })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(ide.getByRole("status").filter({ hasText: /^saved$/ })).toBeVisible();
  await expect(tree.getByRole("button", { name: /app\.ts.*changed/ }).first()).toBeVisible();

  // Run a command in the terminal.
  const command = ide.getByRole("textbox", { name: "Command" });
  await command.fill("ls");
  await command.press("Enter");
  const log = ide.getByRole("log", { name: "Terminal output" });
  await expect(log).toContainText(/exit \d+/, { timeout: 150_000 });
  await expect(log).toContainText("PASS · exit 0");
  await evidence(page, info, "code-session");

  // Discard: the inline confirmation, then back to browse mode.
  await ide.getByRole("button", { name: "Discard session" }).click();
  await ide.getByRole("button", { name: "Discard edits" }).click();
  await expect(page.getByRole("region", { name: "Edit session" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start editing" })).toBeVisible();
  await expect(page).not.toHaveURL(/edit=/);
});
