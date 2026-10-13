// Runs a showcase walkthrough: terminal scenes recorded in a real terminal (record-session.py) and
// browser scenes recorded by Playwright, in order, against one generated project.
//   node director.mjs <scenario> <work-directory> <output-directory>
// Writes scene-<n>.cast / scene-<n>.webm and scenes.json to the output directory; compose.mjs
// turns them into one video.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { scenarios } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [name, work, out] = process.argv.slice(2);
const scenario = scenarios[name];
if (!scenario) throw new Error(`Unknown scenario "${name}". Known: ${Object.keys(scenarios).join(", ")}`);

const state = join(out, "state");
mkdirSync(state, { recursive: true });
mkdirSync(work, { recursive: true });

const scenes = [];
const app = join(work, "my-app");
const baseURL = "http://localhost:3000";
let storageState; // the signed-in session, carried from one browser scene to the next

/** Runs a command off camera; throws when it fails. */
function sh(command, cwd = app) {
  const result = spawnSync("bash", ["-c", command], { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Off-camera command failed (${result.status}): ${command}`);
}

/** A terminal scene: a bash body using the helpers in term.sh, recorded 100x30. */
function terminal(label, body) {
  const index = scenes.length;
  const script = join(state, `scene-${index}.sh`);
  writeFileSync(
    script,
    `set -euo pipefail\nsource ${JSON.stringify(join(here, "term.sh"))}\ncd ${JSON.stringify(work)}\n` +
      `[ -d my-app ] && cd my-app\n${body}\nsleep 1.5\n`,
  );
  const cast = join(out, `scene-${index}.cast`);
  const result = spawnSync("python3", [join(here, "record-session.py"), "100", "30", cast, "bash", script], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, SHOWCASE_STATE: state },
  });
  if (result.status !== 0) throw new Error(`Terminal scene "${label}" failed with status ${result.status}`);
  scenes.push({ kind: "terminal", label, file: `scene-${index}.cast` });
}

// A visible pointer: Playwright's video has none, so clicks would look like magic.
const cursorScript = () => {
  const draw = () => {
    if (document.getElementById("__showcase_cursor")) return;
    const cursor = document.createElement("div");
    cursor.id = "__showcase_cursor";
    cursor.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l16 11-7 1.5L9.5 21z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const saved = JSON.parse(sessionStorage.getItem("__showcase_cursor") ?? "[640,400]");
    Object.assign(cursor.style, {
      position: "fixed",
      left: "0",
      top: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
      transform: `translate(${saved[0]}px, ${saved[1]}px)`,
      transition: "transform 0.55s cubic-bezier(0.3, 0.7, 0.2, 1)",
      filter: "drop-shadow(0 2px 3px rgb(0 0 0 / 0.35))",
    });
    document.documentElement.append(cursor);
  };
  window.__showcaseMove = (x, y) => {
    draw();
    const cursor = document.getElementById("__showcase_cursor");
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    sessionStorage.setItem("__showcase_cursor", JSON.stringify([x, y]));
  };
  window.__showcasePress = () => {
    const cursor = document.getElementById("__showcase_cursor");
    if (!cursor) return;
    cursor.animate([{ scale: "1" }, { scale: "0.82" }, { scale: "1" }], { duration: 260 });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", draw);
  else draw();
};

/** Helpers for browser scenes: paced like a person, with the pointer moving to what is used. */
function actions(page) {
  const point = async (locator) => {
    await locator.waitFor({ state: "visible", timeout: 30_000 });
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) return;
    await page.evaluate(([x, y]) => window.__showcaseMove?.(x, y), [box.x + box.width / 2, box.y + box.height / 2]);
    await page.waitForTimeout(650);
  };
  return {
    page,
    baseURL,
    pause: (ms = 1200) => page.waitForTimeout(ms),
    goto: async (url, ms = 1500) => {
      await page.goto(url);
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(ms);
    },
    point,
    click: async (locator, ms = 900) => {
      await point(locator);
      await page.evaluate(() => window.__showcasePress?.());
      await locator.click();
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(ms);
    },
    type: async (locator, text) => {
      await point(locator);
      await locator.click();
      await locator.pressSequentially(text, { delay: 45 });
      await page.waitForTimeout(250);
    },
    scrollTo: async (locator, ms = 1400) => {
      await locator.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
      await page.waitForTimeout(ms);
    },
  };
}

/** A browser scene: Playwright drives the app, recorded at 1280x800. */
async function browser(label, steps) {
  const index = scenes.length;
  const videoDir = join(state, `video-${index}`);
  const instance = await chromium.launch();
  const context = await instance.newContext({
    baseURL,
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
    colorScheme: "light",
    ...(storageState ? { storageState } : {}),
  });
  await context.addInitScript(cursorScript);
  const page = await context.newPage();
  const started = Date.now();
  const urls = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && frame.url() !== "about:blank") {
      urls.push({ t: (Date.now() - started) / 1000, url: frame.url() });
    }
  });
  try {
    await steps(actions(page));
    await page.waitForTimeout(1200);
    storageState = await context.storageState();
  } catch (error) {
    // Keep what the page looked like, for the failure artifact.
    await page.screenshot({ path: join(state, `scene-${index}-failure.png`) }).catch(() => {});
    writeFileSync(join(state, `scene-${index}-failure.html`), await page.content().catch(() => ""));
    console.error(`Browser scene "${label}" failed at ${page.url()}`);
    throw error;
  } finally {
    await context.close();
    await instance.close();
  }
  const [video] = readdirSync(videoDir).filter((f) => f.endsWith(".webm"));
  renameSync(join(videoDir, video), join(out, `scene-${index}.webm`));
  // The video starts with a blank page; it is trimmed to the first navigation.
  const trim = urls.length ? Math.max(0, urls[0].t - 0.1) : 0;
  scenes.push({ kind: "browser", label, file: `scene-${index}.webm`, trim, urls });
}

const meta = await scenario({ terminal, browser, sh, app, work, env: process.env });
writeFileSync(join(out, "scenes.json"), JSON.stringify({ scenario: name, ...meta, scenes }, null, 2));
console.log(`Recorded ${scenes.length} scenes for ${name}.`);
