import { describe, expect, it } from "vitest";
import {
  legacyManifest,
  ManifestError,
  parseTemplateManifest,
  readTemplateManifest,
} from "../src/core/manifest.js";
import { createPlan, describePlan } from "../src/core/plan.js";
import { manifest, temporaryDirectory, writeFiles } from "./helpers.js";

describe("parseTemplateManifest", () => {
  it("accepts a valid manifest", () => {
    expect(parseTemplateManifest(JSON.stringify(manifest))).toEqual(manifest);
  });

  it("asks for a newer CLI when the schema is newer than it supports", () => {
    expect(() => parseTemplateManifest(JSON.stringify({ ...manifest, schemaVersion: 2 }))).toThrow(
      /template schema 2.*@latest/,
    );
  });

  it.each([
    ["invalid JSON", "{"],
    ["a missing schemaVersion", JSON.stringify({ ...manifest, schemaVersion: undefined })],
    ["another package manager", JSON.stringify({ ...manifest, packageManager: "npm" })],
    ["a missing app", JSON.stringify({ ...manifest, app: "" })],
    ["a malformed env", JSON.stringify({ ...manifest, env: "x" })],
    ["a malformed exclude", JSON.stringify({ ...manifest, exclude: "x" })],
  ])("rejects %s", (_label, source) => {
    expect(() => parseTemplateManifest(source)).toThrow(ManifestError);
  });

  it("falls back to the legacy layout when a Starter has no manifest", async () => {
    expect(await readTemplateManifest(await temporaryDirectory())).toEqual(legacyManifest);
  });

  it("reads the manifest from a template root", async () => {
    const root = await temporaryDirectory();
    await writeFiles(root, { "clubedge.template.json": JSON.stringify(manifest) });
    expect(await readTemplateManifest(root)).toEqual(manifest);
  });
});

const files = (...paths: string[]) => paths.map((path) => ({ from: path, to: path }));
const basePlanInput = {
  targetDirectory: "/projects/my-product",
  identity: { packageName: "my-product", displayName: "My Product" },
  manifest: parseTemplateManifest(JSON.stringify(manifest)),
  cliVersion: "9.9.9",
  git: true,
  install: false,
};

describe("createPlan", () => {
  it("copies template files except excluded and local environment files", () => {
    const plan = createPlan({
      ...basePlanInput,
      source: {
        repository: "Clubedge/clubedge-starter",
        ref: "v0.3.0",
        commit: "b".repeat(40),
        files: files(
          "package.json",
          "README.md",
          ".env.example",
          "clubedge.template.json",
          "apps/web/.env.local",
          "apps/web/src/config/site.json",
        ),
      },
    });

    expect(plan.files.map(({ to }) => to)).toEqual([
      "package.json",
      "README.md",
      ".env.example",
      "apps/web/src/config/site.json",
    ]);
    expect(plan.edits.map(({ path }) => path)).toEqual([
      "package.json",
      "README.md",
      "apps/web/src/config/site.json",
    ]);
    expect(plan.envFile).toEqual({ from: ".env.example", to: "apps/web/.env.local" });
    expect(plan.provenance).toEqual({
      cliVersion: "9.9.9",
      starterRepository: "Clubedge/clubedge-starter",
      starterRef: "v0.3.0",
      starterCommit: "b".repeat(40),
    });
  });

  it("edits branded source files for Starters without a site config", () => {
    const plan = createPlan({
      ...basePlanInput,
      manifest: legacyManifest,
      source: {
        repository: "Clubedge/clubedge-starter",
        ref: "v0.1.1",
        files: files("package.json", "apps/web/src/app/layout.tsx", "apps/web/src/app/page.tsx"),
      },
    });

    expect(plan.edits.map(({ path }) => path)).toEqual([
      "package.json",
      "apps/web/src/app/layout.tsx",
      "apps/web/src/app/page.tsx",
    ]);
    expect(plan.envFile).toBeNull();
  });

  it("describes every step for --dry-run", () => {
    const plan = createPlan({
      ...basePlanInput,
      source: {
        repository: "Clubedge/clubedge-starter",
        ref: "v0.3.0",
        commit: "c".repeat(40),
        files: files("package.json", ".env.example"),
      },
    });

    expect(describePlan(plan)).toEqual([
      "Create /projects/my-product",
      "Copy 2 files from Clubedge/clubedge-starter@v0.3.0 (cccccccc)",
      'Edit package.json: Name the package "my-product" and record its origin',
      "Create apps/web/.env.local from .env.example",
      "Initialize a Git repository on main",
      "Skip dependency installation",
    ]);
  });
});
