import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const baseUrl = process.env.APP_BASE_URL ?? "http://127.0.0.1:3000";
const timeout = Date.now() + 60_000;

// Run from the generated project; its package.json records the selected modules.
const { clubedge } = JSON.parse(await readFile("package.json", "utf8"));
const hasAuth = clubedge?.modules?.auth !== "none";

async function get(path) {
  let lastError;

  while (Date.now() < timeout) {
    try {
      return await fetch(new URL(path, baseUrl), {
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  throw new Error(`The generated app did not respond at ${baseUrl}: ${lastError}`);
}

const landing = await get("/");
assert.equal(landing.status, 200, "the landing page should render");
assert.match(await landing.text(), /Generated App/, "the generated project name should be rendered");

if (hasAuth) {
  const login = await get("/login?mode=signup");
  assert.equal(login.status, 200, "the sign-up page should render");
  assert.match(await login.text(), /Create your account/, "the sign-up view should be available");
} else {
  const login = await get("/login");
  assert.equal(login.status, 404, "projects without auth should have no login page");
}

const dashboard = await get("/dashboard");
assert.equal(dashboard.status, 200, "the dashboard should render");

const health = await get("/api/health");
assert.equal(health.status, 200, "the health endpoint should respond");
assert.equal((await health.json()).status, "ok", "the health endpoint should report success");

const logo = await get("/.well-known/logo.svg");
assert.equal(logo.status, 200, "the Clubedge logo should be served");
assert.match(logo.headers.get("content-type") ?? "", /image\/svg\+xml/);

const favicon = await get("/favicon.ico");
assert.equal(favicon.status, 200, "the favicon should be served");

console.log("Generated app smoke checks passed: pages, health endpoint, logo, and favicon");
