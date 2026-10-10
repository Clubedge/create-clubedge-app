import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, parse } from "node:path";
import { describe, expect, it } from "vitest";
import { assertTargetIsUsable, executePlan, TargetError } from "../src/core/execute.js";
import { readTemplateManifest } from "../src/core/manifest.js";
import { createPlan } from "../src/core/plan.js";
import { readBundledTemplate, readDirectoryTemplate, type TemplateSource } from "../src/core/source.js";
import { listTemplateFiles, pathExists, toPackedPath } from "../src/utils/fs.js";
import { starterFiles, temporaryDirectory, writeFiles } from "./helpers.js";

async function scaffold(source: TemplateSource, targetDirectory: string) {
  const manifest = await readTemplateManifest(source.root);
  const plan = createPlan({
    targetDirectory,
    identity: { packageName: "my-product", displayName: "My Product" },
    source,
    manifest,
    cliVersion: "9.9.9",
    git: false,
    install: false,
  });
  await executePlan(plan, source);
  return plan;
}

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

describe("listTemplateFiles", () => {
  it("skips dependencies, build output, and local secrets outside a Git work tree", async () => {
    const root = await temporaryDirectory();
    await writeFiles(root, {
      "package.json": "{}",
      ".env.example": "",
      ".env.local": "SECRET=1",
      "apps/web/.env": "SECRET=1",
      "node_modules/x/index.js": "",
      "apps/web/.next/server.js": "",
      "apps/web/src/page.tsx": "",
    });

    expect(await listTemplateFiles(root)).toEqual([".env.example", "apps/web/src/page.tsx", "package.json"]);
  });
});

describe("scaffolding a project", () => {
  it("creates a customized project from a local Starter directory", async () => {
    const starter = await temporaryDirectory();
    await writeFiles(starter, starterFiles());
    const target = join(await temporaryDirectory(), "my-product");

    await scaffold(await readDirectoryTemplate(starter), target);

    const files = await listTemplateFiles(target);
    expect(files).not.toContain("clubedge.template.json");
    expect((await readJson(join(target, "package.json"))).name).toBe("my-product");
    expect((await readJson(join(target, "apps/web/src/config/site.json"))).name).toBe("My Product");
    expect(await readFile(join(target, "README.md"), "utf8")).toMatch(/^# My Product\n/);
    expect(await readFile(join(target, "apps/web/.env.local"), "utf8")).toBe("DATABASE_URL=\n");
    expect(await readFile(join(target, ".gitignore"), "utf8")).toBe("node_modules/\n");
  });

  it("restores packed dotfiles from the bundled template", async () => {
    const bundle = await temporaryDirectory();
    const template = join(bundle, "template");
    const packed = Object.fromEntries(
      Object.entries(starterFiles()).map(([path, content]) => [toPackedPath(path), content]),
    );
    await writeFiles(template, packed);
    await writeFile(
      join(bundle, "template.lock.json"),
      JSON.stringify({
        repository: "Clubedge/clubedge-starter",
        ref: "v0.3.0",
        commit: "d".repeat(40),
        files: Object.keys(packed),
      }),
    );
    const source = await readBundledTemplate(join(bundle, "template.lock.json"), template);
    const target = join(await temporaryDirectory(), "my-product");

    const plan = await scaffold(source!, target);

    expect(await pathExists(join(target, ".gitignore"))).toBe(true);
    expect(await pathExists(join(target, "_gitignore"))).toBe(false);
    expect(plan.provenance).toMatchObject({ starterRef: "v0.3.0", starterCommit: "d".repeat(40) });
  });

  it("removes a directory it created when scaffolding fails", async () => {
    const starter = await temporaryDirectory();
    await writeFiles(starter, { ...starterFiles(), "package.json": "{ not json" });
    const target = join(await temporaryDirectory(), "my-product");

    await expect(scaffold(await readDirectoryTemplate(starter), target)).rejects.toThrow();
    expect(await pathExists(target)).toBe(false);
  });

  it("empties, but keeps, a pre-existing empty directory when scaffolding fails", async () => {
    const starter = await temporaryDirectory();
    await writeFiles(starter, { ...starterFiles(), "package.json": "{ not json" });
    const target = join(await temporaryDirectory(), "my-product");
    await mkdir(target);

    await expect(scaffold(await readDirectoryTemplate(starter), target)).rejects.toThrow();
    expect(await readdir(target)).toEqual([]);
  });
});

describe("assertTargetIsUsable", () => {
  it("accepts missing and empty directories", async () => {
    const root = await temporaryDirectory();
    await expect(assertTargetIsUsable(join(root, "new"))).resolves.toBeUndefined();
    await expect(assertTargetIsUsable(root)).resolves.toBeUndefined();
  });

  it("refuses non-empty directories and filesystem roots", async () => {
    const root = await temporaryDirectory();
    await writeFiles(root, { "keep.txt": "mine" });
    await expect(assertTargetIsUsable(root)).rejects.toThrow(TargetError);
    await expect(assertTargetIsUsable(parse(root).root)).rejects.toThrow("filesystem root");
    expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("mine");
  });
});

describe("readDirectoryTemplate", () => {
  it("rejects a directory that is not a Starter", async () => {
    await expect(readDirectoryTemplate(await temporaryDirectory())).rejects.toThrow("package.json is missing");
  });
});
