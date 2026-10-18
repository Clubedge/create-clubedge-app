import { describe, expect, it } from "vitest";
import { ManifestError, parseTemplateManifest, readTemplateManifest } from "../src/core/manifest.js";
import type { Packs } from "../src/core/manifest-packs.js";
import { createPlan, describePlan, ModuleError, selectModules, selectStacks, slotChoices, StackError } from "../src/core/plan.js";
import { temporaryDirectory, writeFiles } from "./helpers.js";

/** A schema 4 Starter: Next.js (full-stack), a Vite frontend, and an API in another language. */
const root = {
  schemaVersion: 4,
  name: "clubedge-starter",
  packageManager: "pnpm",
  siteConfig: "apps/web/src/config/site.json",
  dockerImage: "clubedge-starter",
  slots: {
    framework: {
      name: "Framework",
      question: "Which framework should the app use?",
      path: "apps/web",
      package: "@clubedge/web",
      env: { example: ".env.example", target: "apps/web/.env.local" },
      dockerfile: "Dockerfile",
      roles: ["fullstack", "frontend"],
      default: "next",
    },
    api: {
      name: "API",
      question: "Which API should the frontend call?",
      path: "apps/api",
      package: "@clubedge/api",
      env: { example: "apps/api/.env.example", target: "apps/api/.env.local" },
      dockerfile: "apps/api/Dockerfile",
      roles: ["api"],
    },
  },
  modules: ["auth", "deploy"],
  conditional: ["README.md"],
  exclude: ["clubedge.template.json"],
};

const modules = {
  auth: {
    name: "Authentication",
    default: "supabase",
    options: {
      supabase: { name: "Supabase Auth", files: ["e2e/auth.spec.ts"] },
      none: { name: "None" },
    },
  },
  deploy: { name: "Deployment", default: "docker", scope: "project", options: { docker: { name: "Docker" } } },
};

const stacks: Packs["stacks"] = [
  {
    directory: "apps/web",
    data: {
      id: "next",
      name: "Next.js",
      role: "fullstack",
      envExample: "../../.env.example",
      dockerfile: "../../Dockerfile",
      conditional: ["next.config.ts"],
      modules: {
        auth: {
          supabase: { files: ["src/app/login"] },
          none: { replace: { "src/server/auth.ts": "src/server/variants/auth.none.ts" } },
        },
      },
    },
  },
  {
    directory: "apps/vite",
    data: {
      id: "vite",
      name: "React + Vite",
      role: "frontend",
      envExample: ".env.example",
      dockerfile: "Dockerfile",
      modules: { auth: { "supabase|none": {} } },
    },
  },
  {
    directory: "apps/api-python",
    data: {
      id: "fastapi",
      name: "FastAPI",
      role: "api",
      envExample: ".env.example",
      dockerfile: "Dockerfile",
      toolchain: { name: "uv", check: ["uv", "--version"], install: ["uv", "sync"], url: "https://docs.astral.sh/uv/" },
      modules: { auth: { none: {} } },
    },
  },
];

const packs: Packs = { stacks, modules };
const manifest = parseTemplateManifest(JSON.stringify(root), packs);
const withStack = (index: number, data: Record<string, unknown>) =>
  stacks.map((stack, i) => (i === index ? { ...stack, data: { ...(stack.data as object), ...data } } : stack));

describe("schema 4 packs", () => {
  it("reads stacks with Starter-relative paths and the options they implement", () => {
    expect(manifest.stacks.next).toEqual({
      name: "Next.js",
      role: "fullstack",
      slot: "framework",
      app: "apps/web",
      envExample: ".env.example",
      dockerfile: "Dockerfile",
      modules: { auth: ["supabase", "none"] },
    });
    expect(manifest.stacks.fastapi).toMatchObject({ slot: "api", app: "apps/api-python", modules: { auth: ["none"] } });
    expect(manifest.stacks.fastapi!.toolchain).toEqual(stacks[2]!.data && (stacks[2]!.data as { toolchain: unknown }).toolchain);
    // Each slot's default first, then by name.
    expect(Object.keys(manifest.stacks)).toEqual(["next", "fastapi", "vite"]);
  });

  it("joins a stack's files for an option to that option's files", () => {
    expect(manifest.modules.auth!.options.supabase!.files).toEqual(["e2e/auth.spec.ts", "apps/web/src/app/login"]);
    expect(manifest.modules.auth!.options.none!.replace).toEqual({
      "apps/web/src/server/auth.ts": "apps/web/src/server/variants/auth.none.ts",
    });
    expect(manifest.modules.deploy!.scope).toBe("project");
    expect(manifest.conditional).toEqual(["README.md", "apps/web/next.config.ts"]);
  });

  it("leaves the descriptors out of generated projects", () => {
    expect(manifest.exclude).toEqual(
      expect.arrayContaining(["clubedge/modules", "apps/web/clubedge.stack.json", "apps/api-python/clubedge.stack.json"]),
    );
  });

  it.each([
    ["a stack path outside the Starter", { stacks: withStack(1, { envExample: "../../../x" }), modules }],
    ["an unknown role", { stacks: withStack(1, { role: "worker" }), modules }],
    ["an unknown option", { stacks: withStack(1, { modules: { auth: { clerk: {} } } }), modules }],
    ["an unknown module", { stacks: withStack(1, { modules: { cache: { redis: {} } } }), modules }],
    ["a duplicate stack id", { stacks: withStack(1, { id: "next" }), modules }],
    ["a malformed toolchain", { stacks: withStack(2, { toolchain: { name: "uv", check: "uv" } }), modules }],
    ["an option no stack implements", { stacks: withStack(0, { modules: { auth: { none: {} } } }).slice(0, 1), modules }],
  ])("rejects %s", (_label, broken) => {
    expect(() => parseTemplateManifest(JSON.stringify(root), broken as Packs)).toThrow(ManifestError);
  });

  it("reads the packs from a Starter's files", async () => {
    const starter = await temporaryDirectory();
    await writeFiles(starter, {
      "clubedge.template.json": JSON.stringify(root),
      "clubedge/modules/auth.json": JSON.stringify(modules.auth),
      "clubedge/modules/deploy.json": JSON.stringify(modules.deploy),
      ...Object.fromEntries(stacks.map(({ directory, data }) => [`${directory}/clubedge.stack.json`, JSON.stringify(data)])),
      "apps/no-pack/package.json": "{}",
    });
    const read = await readTemplateManifest(starter);
    // Folders are read in name order, so only the order of the excluded descriptors differs.
    expect({ ...read, exclude: [...read.exclude].sort() }).toEqual({ ...manifest, exclude: [...manifest.exclude].sort() });
  });
});

describe("selecting stacks", () => {
  it("uses the defaults, leaving optional slots empty", () => {
    expect(selectStacks(manifest)).toEqual({ framework: "next", api: "none" });
  });

  it("needs an API for a frontend, and none for a full-stack app", () => {
    expect(selectStacks(manifest, { framework: "vite", api: "fastapi" })).toEqual({ framework: "vite", api: "fastapi" });
    expect(() => selectStacks(manifest, { framework: "vite" })).toThrow(
      "React + Vite is a frontend and calls an API: choose one with --api (fastapi).",
    );
    expect(() => selectStacks(manifest, { api: "fastapi" })).toThrow(StackError);
    expect(() => selectStacks(manifest, { api: "django" })).toThrow('Unknown api "django". This Starter offers: fastapi, none.');
  });

  it("offers only the stacks that fit earlier answers", () => {
    expect(slotChoices(manifest, "framework")).toEqual(["next", "vite"]);
    expect(slotChoices(manifest, "api", { framework: "next" })).toEqual(["none"]);
    expect(slotChoices(manifest, "api", { framework: "vite" })).toEqual(["fastapi"]);
  });
});

describe("modules with stacks", () => {
  const decoupled = selectStacks(manifest, { framework: "vite", api: "fastapi" });

  it("falls back to an option every involved stack implements", () => {
    expect(selectModules(manifest, {}, decoupled)).toEqual({ auth: "none", deploy: "docker" });
  });

  it("names the stack that lacks a requested option", () => {
    expect(() => selectModules(manifest, { auth: "supabase" }, decoupled)).toThrow(ModuleError);
    expect(() => selectModules(manifest, { auth: "supabase" }, decoupled)).toThrow(
      "FastAPI does not implement Supabase Auth (--auth supabase). It implements: none.",
    );
  });

  it("places every selected app in its slot and installs its own tools", () => {
    const plan = createPlan({
      targetDirectory: "/projects/my-product",
      identity: { packageName: "my-product", displayName: "My Product" },
      source: {
        repository: "Clubedge/clubedge-starter",
        ref: "v1.0.0",
        files: [
          "package.json",
          "apps/web/package.json",
          "apps/vite/package.json",
          "apps/vite/.env.example",
          "apps/vite/clubedge.stack.json",
          "apps/api-python/pyproject.toml",
          "apps/api-python/.env.example",
          "apps/api-python/Dockerfile",
          "clubedge/modules/auth.json",
        ].map((path) => ({ from: path, to: path })),
      },
      manifest,
      stacks: { framework: "vite", api: "fastapi" },
      cliVersion: "9.9.9",
      git: false,
      install: true,
    });
    expect(plan.files.map(({ to }) => to)).toEqual([
      "package.json",
      "apps/web/package.json",
      ".env.example",
      "apps/api/pyproject.toml",
      "apps/api/.env.example",
      "apps/api/Dockerfile",
    ]);
    expect(plan.envFiles).toEqual([
      { from: ".env.example", to: "apps/web/.env.local" },
      { from: "apps/api/.env.example", to: "apps/api/.env.local" },
    ]);
    expect(plan.provenance.stacks).toEqual({ framework: "vite", api: "fastapi" });
    expect(describePlan(plan)).toContain("Install the FastAPI app's dependencies in apps/api with uv");
  });
});
