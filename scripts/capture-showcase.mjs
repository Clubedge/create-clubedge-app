// Screenshots of a generated project for the showcase on starter.clubedge.live.
// Copied into the generated project and run from there, against its production server:
//   node scripts/capture-showcase.mjs <output-directory>
// Every page is captured in light and dark, as a visitor with that system theme sees it.
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const baseUrl = process.env.APP_BASE_URL ?? "http://127.0.0.1:3000";
const output = process.argv[2];
if (!output) throw new Error("Usage: node scripts/capture-showcase.mjs <output-directory>");
await mkdir(output, { recursive: true });

const browser = await chromium.launch();
try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({
      baseURL: baseUrl,
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      colorScheme: theme,
    });
    const page = await context.newPage();
    const shot = async (name) => {
      await page.waitForLoadState("networkidle");
      // Let entrance transitions finish before the capture.
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${output}/${name}-${theme}.png` });
      console.log(`captured ${name}-${theme}.png`);
    };

    await page.goto("/");
    await shot("home");

    await page.goto("/login");
    await shot("login");

    // A fresh demo account per theme, so each run starts from the same state.
    await page.goto("/login?mode=signup");
    await page.getByLabel("Email").fill(`demo-${theme}-${Date.now()}@example.com`);
    await page.getByLabel("Password", { exact: true }).fill("showcase demo password");
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL(/\/dashboard$/);

    await page.goto("/settings");
    await page.getByLabel("Display name").fill("Ada Lovelace");
    await page.getByRole("button", { name: "Save profile" }).click();
    await page.getByRole("status").filter({ hasText: "Your profile was saved." }).waitFor();
    await page.reload();
    await shot("settings");

    await page.goto("/dashboard");
    await shot("dashboard");

    await context.close();
  }
} finally {
  await browser.close();
}
