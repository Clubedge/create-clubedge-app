import { describe, expect, it } from "vitest";
import {
  legacyManifest,
  ManifestError,
  parseTemplateManifest,
  readTemplateManifest,
} from "../src/core/manifest.js";
import { createPlan, describePlan, FrameworkError } from "../src/core/plan.js";
import { frameworksManifest, manifest, temporaryDirectory, writeFiles } from "./helpers.js";

/** Schema 1 Starters are read as a single Next.js framework in the app directory. */
const parsedSchema1 = {
  ...manifest,
  defaultFramework: "next",
  frameworks: {
    next: { name: "Next.js", app: "apps/web", envExample: ".env.example", dockerfile: "Dockerfile" },
  },
  modules: {},
  conditional: [],
};

describe("parseTemplateManifest", () => {
  it("reads a schema 1 manifest as a single Next.js framework", () => {
    expect(parseTemplateManifest(JSON.stringify(manifest))).toEqual(parsedSchema1);
  });

  it("reads a schema 2 manifest with several frameworks", () => {
    expect(parseTemplateManifest(JSON.stringify(frameworksManifest))).toEqual({
      ...frameworksManifest,
      modules: {},
      conditional: [],
    });
  });

  it("asks for a newer CLI when the schema is newer than it supports", () => {
    expect(() => parseTemplateManifest(JSON.stringify({ ...frameworksManifest, schemaVersion: 4 }))).toThrow(
      /template schema 4.*@latest/,
    );
  });

  it.each([
    ["invalid JSON", "{"],
    ["a missing schemaVersion", JSON.stringify({ ...manifest, schemaVersion: undefined })],
    ["another package manager", JSON.stringify({ ...manifest, packageManager: "npm" })],
    ["a missing app", JSON.stringify({ ...manifest, app: "" })],
    ["a malformed env", JSON.stringify({ ...manifest, env: "x" })],
    ["a malformed exclude", JSON.stringify({ ...manifest, exclude: "x" })],
    ["schema 2 without frameworks", JSON.stringify({ ...frameworksManifest, frameworks: {} })],
    ["schema 2 without appPackage", JSON.stringify({ ...frameworksManifest, appPackage: undefined })],
    ["an unknown default framework", JSON.stringify({ ...frameworksManifest, defaultFramework: "remix" })],
    [
      "an invalid framework id",
      JSON.stringify({ ...frameworksManifest, frameworks: { "Next JS": frameworksManifest.frameworks.next } }),
    ],
    [
      "an incomplete framework",
      JSON.stringify({
        ...frameworksManifest,
        frameworks: { ...frameworksManifest.frameworks, next: { name: "Next.js", app: "apps/web" } },
      }),
    ],
  ])("rejects %s", (_label, source) => {
    expect(() => parseTemplateManifest(source)).toThrow(ManifestError);
  });

  it("falls back to the legacy layout when a Starter has no manifest", async () => {
    expect(await readTemplateManifest(await temporaryDirectory())).toEqual(legacyManifest);
  });

  it("reads the manifest from a template root", async () => {
    const root = await temporaryDirectory();
    await writeFiles(root, { "clubedge.template.json": JSON.stringify(manifest) });
    expect(await readTemplateManifest(root)).toEqual(parsedSchema1);
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
    // A single-framework Starter records no framework choice.
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

describe("createPlan with several frameworks", () => {
  const source = {
    repository: "Clubedge/clubedge-starter",
    ref: "v0.4.0",
    files: files(
      "package.json",
      "pnpm-lock.yaml",
      ".env.example",
      "Dockerfile",
      "apps/web/package.json",
      "apps/web/src/config/site.json",
      "apps/web/src/app/page.tsx",
      "apps/start/package.json",
      "apps/start/.env.example",
      "apps/start/.env.local",
      "apps/start/Dockerfile",
      "apps/start/src/config/site.json",
      "apps/start/src/routes/index.tsx",
      "packages/core/src/index.ts",
    ),
  };
  const input = { ...basePlanInput, manifest: parseTemplateManifest(JSON.stringify(frameworksManifest)), source };

  it("keeps the default framework in place and leaves the others out", () => {
    const plan = createPlan(input);

    expect(plan.framework).toEqual({ id: "next", name: "Next.js" });
    expect(plan.files.map(({ to }) => to)).toEqual([
      "package.json",
      "pnpm-lock.yaml",
      ".env.example",
      "Dockerfile",
      "apps/web/package.json",
      "apps/web/src/config/site.json",
      "apps/web/src/app/page.tsx",
      "packages/core/src/index.ts",
    ]);
    expect(plan.edits.map(({ path }) => path)).toEqual([
      "package.json",
      "pnpm-lock.yaml",
      "apps/web/src/config/site.json",
    ]);
    expect(plan.provenance).toMatchObject({ framework: "next", frameworkName: "Next.js" });
  });

  it("moves the selected framework's app, env example, and Dockerfile into place", () => {
    const plan = createPlan({ ...input, framework: "tanstack-start" });

    expect(plan.framework).toEqual({ id: "tanstack-start", name: "TanStack Start" });
    expect(plan.files).toEqual([
      { from: "package.json", to: "package.json" },
      { from: "pnpm-lock.yaml", to: "pnpm-lock.yaml" },
      { from: "apps/start/package.json", to: "apps/web/package.json" },
      { from: "apps/start/.env.example", to: ".env.example" },
      { from: "apps/start/Dockerfile", to: "Dockerfile" },
      { from: "apps/start/src/config/site.json", to: "apps/web/src/config/site.json" },
      { from: "apps/start/src/routes/index.tsx", to: "apps/web/src/routes/index.tsx" },
      { from: "packages/core/src/index.ts", to: "packages/core/src/index.ts" },
    ]);
    expect(plan.envFile).toEqual({ from: ".env.example", to: "apps/web/.env.local" });
    expect(describePlan(plan)).toEqual([
      "Create /projects/my-product",
      "Use TanStack Start",
      "Copy 8 files from Clubedge/clubedge-starter@v0.4.0",
      'Edit package.json: Name the package "my-product" and record its origin',
      'Edit apps/web/package.json: Name the TanStack Start app "@clubedge/web"',
      "Edit pnpm-lock.yaml: Keep only the TanStack Start app in the lockfile",
      'Edit apps/web/src/config/site.json: Set the project name to "My Product"',
      "Create apps/web/.env.local from .env.example",
      "Initialize a Git repository on main",
      "Skip dependency installation",
    ]);
  });

  it("names the available frameworks when the requested one is unknown", () => {
    expect(() => createPlan({ ...input, framework: "remix" })).toThrow(FrameworkError);
    expect(() => createPlan({ ...input, framework: "remix" })).toThrow(
      'Unknown framework "remix". This Starter offers: next, tanstack-start.',
    );
  });

  it("offers only next for schema 1 Starters", () => {
    expect(() => createPlan({ ...basePlanInput, source, framework: "tanstack-start" })).toThrow(
      "This Starter offers: next.",
    );
  });
});
