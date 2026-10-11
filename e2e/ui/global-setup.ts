/// <reference lib="dom" />
import { mkdirSync } from "node:fs";
import { chromium, type FullConfig } from "@playwright/test";
import { signInPage } from "./clerk";

/** Signs the smoke user in once and saves the session for every test. */
export default async function globalSetup(config: FullConfig) {
  const use = config.projects[0]?.use ?? {};
  const baseURL = use.baseURL ?? "https://rhumbatron.com";
  mkdirSync("e2e/.auth", { recursive: true });
  const browser = await chromium.launch({ args: use.launchOptions?.args ?? [] });
  const page = await browser.newPage();
  await signInPage(page, baseURL);
  await page.context().storageState({ path: "e2e/.auth/smoke.json" });
  await browser.close();
}
