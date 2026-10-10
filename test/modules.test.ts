import { describe, expect, it } from "vitest";
import { ManifestError, parseTemplateManifest } from "../src/core/manifest.js";
import { createPlan, describePlan, ModuleError, selectModules } from "../src/core/plan.js";
import { frameworksManifest, modulesManifest } from "./helpers.js";

const manifest = parseTemplateManifest(JSON.stringify(modulesManifest));
const withModules = (modules: unknown) => JSON.stringify({ ...modulesManifest, modules });

describe("parsing schema 3 modules", () => {
  it("reads modules, normalizing single requirements to lists", () => {
    expect(Object.keys(manifest.modules)).toEqual(["auth", "storage"]);
    expect(manifest.modules.storage!.options.supabase).toEqual({
      name: "Supabase Storage",
      packages: { "@clubedge/storage-supabase": "packages/storage-supabase" },
      files: ["apps/web/src/server/storage.ts", "apps/start/src/server/storage.ts"],
      replace: {
        "apps/web/src/server/storage.ts": "apps/web/src/server/variants/storage.supabase.ts",
        "apps/start/src/server/storage.ts": "apps/start/src/server/variants/storage.supabase.ts",
      },
      requires: { auth: ["supabase"] },
    });
    expect(manifest.modules.storage!.options.none).toEqual({
      name: "None",
      packages: {},
      files: [],
      replace: {},
      requires: {},
    });
    expect(manifest.conditional).toEqual([".env.example", "apps/start/.env.example", "README.md"]);
  });

  it("ignores modules in schema 2 manifests", () => {
    const parsed = parseTemplateManifest(JSON.stringify({ ...frameworksManifest, modules: modulesManifest.modules }));
    expect(parsed.modules).toEqual({});
  });

  it.each([
    ["an unknown default", withModules({ auth: { name: "Auth", default: "x", options: { none: { name: "None" } } } })],
    ["no options", withModules({ auth: { name: "Auth", default: "none", options: {} } })],
    ["an invalid module id", withModules({ Auth: { name: "Auth", default: "none", options: { none: { name: "None" } } } })],
    ["a module named framework", withModules({ framework: { name: "F", default: "a", options: { a: { name: "A" } } } })],
    ["an invalid option id", withModules({ auth: { name: "Auth", default: "None", options: { None: { name: "None" } } } })],
    ["an option without a name", withModules({ auth: { name: "Auth", default: "none", options: { none: {} } } })],
    ["malformed files", withModules({ auth: { name: "Auth", default: "none", options: { none: { name: "None", files: "x" } } } })],
    ["malformed packages", withModules({ auth: { name: "Auth", default: "none", options: { none: { name: "None", packages: ["x"] } } } })],
    [
      "a requirement on an unknown option",
      withModules({
        auth: { name: "Auth", default: "none", options: { none: { name: "None", requires: { storage: "ftp" } } } },
      }),
    ],
  ])("rejects %s", (_label, source) => {
    expect(() => parseTemplateManifest(source)).toThrow(ManifestError);
  });
});

describe("selectModules", () => {
  it("uses each module's default", () => {
    expect(selectModules(manifest)).toEqual({ auth: "supabase", storage: "s3" });
  });

  it("applies requested options", () => {
    expect(selectModules(manifest, { auth: "none", storage: "none" })).toEqual({ auth: "none", storage: "none" });
  });

  it("explains a missing requirement", () => {
    expect(() => selectModules(manifest, { auth: "none", storage: "supabase" })).toThrow(
      "Supabase Storage needs Supabase Auth (--auth supabase).",
    );
  });

  it("names the available choices for unknown modules and options", () => {
    expect(() => selectModules(manifest, { cache: "redis" })).toThrow(
      'Unknown module "cache". This Starter offers: auth, storage.',
    );
    expect(() => selectModules(manifest, { auth: "clerk" })).toThrow(
      'Unknown auth option "clerk". Choose one of: supabase, none.',
    );
  });

  it("refuses module flags for Starters without modules", () => {
    const older = parseTemplateManifest(JSON.stringify(frameworksManifest));
    expect(() => selectModules(older, { auth: "none" })).toThrow(ModuleError);
    expect(() => selectModules(older, { auth: "none" })).toThrow("does not offer module choices");
  });
});

const source = {
  repository: "Clubedge/clubedge-starter",
  ref: "v0.5.0",
  files: [
    "package.json",
    "pnpm-lock.yaml",
    "README.md",
    ".env.example",
    "Dockerfile",
    "apps/web/package.json",
    "apps/web/src/app/login/page.tsx",
    "apps/web/src/config/site.json",
    "apps/web/src/server/auth.ts",
    "apps/web/src/server/variants/auth.none.ts",
    "apps/web/src/server/storage.ts",
    "apps/web/src/server/variants/storage.supabase.ts",
    "apps/start/package.json",
    "apps/start/.env.example",
    "apps/start/Dockerfile",
    "apps/start/src/config/site.json",
    "apps/start/src/routes/login.tsx",
    "apps/start/src/server/auth.ts",
    "apps/start/src/server/variants/auth.none.ts",
    "apps/start/src/server/storage.ts",
    "apps/start/src/server/variants/storage.supabase.ts",
    "packages/auth-supabase/package.json",
    "packages/storage-s3/package.json",
    "packages/storage-s3/src/index.ts",
    "packages/storage-supabase/package.json",
  ].map((path) => ({ from: path, to: path })),
};
const input = {
  targetDirectory: "/projects/my-product",
  identity: { packageName: "my-product", displayName: "My Product" },
  manifest,
  source,
  cliVersion: "9.9.9",
  git: false,
  install: false,
};
const targets = (plan: ReturnType<typeof createPlan>) => plan.files.map(({ to }) => to);

describe("createPlan with modules", () => {
  it("keeps the default options and leaves out unused variants and packages", () => {
    const plan = createPlan(input);

    expect(targets(plan)).toEqual([
      "package.json",
      "pnpm-lock.yaml",
      "README.md",
      ".env.example",
      "Dockerfile",
      "apps/web/package.json",
      "apps/web/src/app/login/page.tsx",
      "apps/web/src/config/site.json",
      "apps/web/src/server/auth.ts",
      "apps/web/src/server/storage.ts",
      "packages/auth-supabase/package.json",
      "packages/storage-s3/package.json",
      "packages/storage-s3/src/index.ts",
    ]);
    expect(plan.provenance).toMatchObject({
      modules: { auth: "supabase", storage: "s3" },
      moduleSummary: ["Authentication: Supabase Auth", "File storage: S3-compatible"],
    });
    expect(describePlan(plan)).toContain("Use Authentication: Supabase Auth, File storage: S3-compatible");
    expect(plan.edits.map(({ path }) => path)).toEqual([
      "package.json",
      "apps/web/package.json",
      "packages/auth-supabase/package.json",
      "packages/storage-s3/package.json",
      "pnpm-lock.yaml",
      ".env.example",
      "README.md",
      "README.md",
      "apps/web/src/config/site.json",
    ]);
  });

  it("swaps in variants, drops owned files, and removes unused packages", () => {
    const plan = createPlan({ ...input, framework: "tanstack-start", modules: { auth: "none", storage: "none" } });

    expect(plan.files).toEqual([
      { from: "package.json", to: "package.json" },
      { from: "pnpm-lock.yaml", to: "pnpm-lock.yaml" },
      { from: "README.md", to: "README.md" },
      { from: "apps/start/package.json", to: "apps/web/package.json" },
      { from: "apps/start/.env.example", to: ".env.example" },
      { from: "apps/start/Dockerfile", to: "Dockerfile" },
      { from: "apps/start/src/config/site.json", to: "apps/web/src/config/site.json" },
      { from: "apps/start/src/server/variants/auth.none.ts", to: "apps/web/src/server/auth.ts" },
    ]);
    expect(describePlan(plan)).toEqual(
      expect.arrayContaining([
        "Use TanStack Start",
        "Use Authentication: None, File storage: None",
        "Edit pnpm-lock.yaml: Keep only the TanStack Start app and the selected modules in the lockfile",
        "Edit .env.example: Keep the sections for the selected framework and modules",
      ]),
    );
  });

  it("replaces a file that several options own with the selected variant", () => {
    const plan = createPlan({ ...input, modules: { storage: "supabase" } });
    expect(plan.files).toContainEqual({
      from: "apps/web/src/server/variants/storage.supabase.ts",
      to: "apps/web/src/server/storage.ts",
    });
    expect(targets(plan)).not.toContain("packages/storage-s3/src/index.ts");
    expect(targets(plan).filter((path) => path === "apps/web/src/server/storage.ts")).toHaveLength(1);
  });

  it("applies the edits for the selection", () => {
    const plan = createPlan({ ...input, framework: "tanstack-start", modules: { auth: "none", storage: "none" } });
    // Apply every edit for a path in order, as executePlan does.
    const edit = (path: string) => ({
      apply: (text: string) =>
        plan.edits.filter((candidate) => candidate.path === path).reduce((result, { apply }) => apply(result), text),
    });

    expect(edit(".env.example").apply("# start\nDATABASE_URL=\n\n# clubedge:if auth=supabase\nSUPABASE_URL=\n# clubedge:end\n")).toBe(
      "# start\nDATABASE_URL=\n",
    );
    const app = JSON.parse(
      edit("apps/web/package.json").apply(
        JSON.stringify({ name: "@clubedge/start", dependencies: { "@clubedge/auth-supabase": "workspace:*", zod: "^4" } }),
      ),
    );
    // Both the rename and the dependency removal apply to the moved app manifest.
    expect(plan.edits.filter(({ path }) => path === "apps/web/package.json")).toHaveLength(2);
    expect(app).toEqual({ name: "@clubedge/web", dependencies: { zod: "^4" } });
  });

  it("refuses an invalid combination before planning any file", () => {
    expect(() => createPlan({ ...input, modules: { auth: "none", storage: "supabase" } })).toThrow(ModuleError);
  });
});
