import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  customizeProject,
  displayNameFromPackageName,
  packageNameFromDirectory,
} from "../bin/create.mjs";

const temporaryDirectories = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("project naming", () => {
  it("normalizes a project directory into a package name", () => {
    assert.equal(packageNameFromDirectory("My Clubedge App"), "my-clubedge-app");
    assert.equal(packageNameFromDirectory("---"), "my-app");
  });

  it("turns a package name into a readable display name", () => {
    assert.equal(displayNameFromPackageName("my-clubedge_app"), "My Clubedge App");
  });
});

describe("customizeProject", () => {
  it("applies project naming to manifests, metadata, landing page, dashboard, and environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "create-clubedge-app-"));
    temporaryDirectories.push(directory);

    const appDirectory = join(directory, "apps", "web", "src", "app");
    await mkdir(join(appDirectory, "dashboard", "_components"), { recursive: true });
    await mkdir(join(directory, "apps", "web"), { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "clubedge-starter-v1", scripts: { "docker:build": "docker build -t clubedge-starter ." } }),
    );
    await writeFile(join(directory, "README.md"), "# Clubedge Starter\n");
    await writeFile(
      join(appDirectory, "layout.tsx"),
      'title: { default: "Clubedge Starter", template: "%s · Clubedge Starter" }, description: "A production-minded foundation for Clubedge applications."',
    );
    await writeFile(join(appDirectory, "page.tsx"), "<span>Clubedge Starter</span><span>Clubedge</span>");
    await writeFile(
      join(appDirectory, "dashboard", "_components", "app-sidebar.tsx"),
      'aria-label="Clubedge Starter home">Clubedge</span>',
    );
    await writeFile(join(appDirectory, "dashboard", "page.tsx"), "<span>Clubedge Starter</span>");
    await mkdir(join(appDirectory, "login"), { recursive: true });
    await writeFile(join(appDirectory, "login", "page.tsx"), "<span>Clubedge Starter</span>");
    await writeFile(join(directory, ".env.example"), "DATABASE_URL=\n");

    await customizeProject(directory, "my-product", "v9.2.0");

    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    const readme = await readFile(join(directory, "README.md"), "utf8");
    const layout = await readFile(join(appDirectory, "layout.tsx"), "utf8");
    const landingPage = await readFile(join(appDirectory, "page.tsx"), "utf8");
    const sidebar = await readFile(
      join(appDirectory, "dashboard", "_components", "app-sidebar.tsx"),
      "utf8",
    );
    const dashboard = await readFile(join(appDirectory, "dashboard", "page.tsx"), "utf8");
    const login = await readFile(join(appDirectory, "login", "page.tsx"), "utf8");
    const localEnvironment = await readFile(join(directory, "apps", "web", ".env.local"), "utf8");

    assert.equal(manifest.name, "my-product");
    assert.equal(manifest.scripts["docker:build"], "docker build -t my-product .");
    assert.deepEqual(manifest.clubedge, {
      cliVersion: "0.1.10",
      starterRepository: "Clubedge/clubedge-starter",
      starterRef: "v9.2.0",
    });
    assert.match(readme, /^# My Product$/m);
    assert.match(readme, /Starter ref: `v9\.2\.0`/);
    assert.match(readme, /CLI version: `0\.1\.10`/);
    assert.match(layout, /default: "My Product"/);
    assert.match(layout, /%s · My Product/);
    assert.match(layout, /My Product application foundation/);
    assert.doesNotMatch(landingPage, /Clubedge Starter|>Clubedge</);
    assert.match(landingPage, />My Product</);
    assert.doesNotMatch(sidebar, /Clubedge Starter|>Clubedge</);
    assert.match(sidebar, />My Product</);
    assert.doesNotMatch(dashboard, /Clubedge Starter/);
    assert.doesNotMatch(login, /Clubedge Starter/);
    assert.equal(localEnvironment, "DATABASE_URL=\n");
  });
});
