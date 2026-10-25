import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/args.js";
import { selectionHelp } from "../src/cli/ui.js";
import { dockerComposeSource, railwayIacSource } from "../src/core/deploy.js";
import { executePlan } from "../src/core/execute.js";
import { ManifestError, parseTemplateManifest, readTemplateManifest } from "../src/core/manifest.js";
import type { Packs } from "../src/core/manifest-packs.js";
import {
  createPlan,
  describePlan,
  ModuleError,
  selectModules,
  selectStacks,
  slotChoices,
  splitSelection,
  StackError,
} from "../src/core/plan.js";
import { projectEnvFiles, readProject, renderProject } from "../src/core/project.js";
import { readDirectoryTemplate } from "../src/core/source.js";
import { siteConfig, temporaryDirectory, writeFiles } from "./helpers.js";

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
      siteConfig: "apps/api/src/config/site.json",
      packages: { "@clubedge/contract": "packages/contract" },
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

  it("refuses a module id that would read outside clubedge/modules", async () => {
    const starter = await temporaryDirectory();
    await writeFiles(starter, {
      "clubedge.template.json": JSON.stringify({ ...root, modules: ["../../outside"] }),
      "outside.json": JSON.stringify(modules.auth),
    });
    await expect(readTemplateManifest(starter)).rejects.toThrow('"../../outside" is not a valid module id.');
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

describe("slot packages", () => {
  const plan = (stacks: Record<string, string>) =>
    createPlan({
      targetDirectory: "/projects/my-product",
      identity: { packageName: "my-product", displayName: "My Product" },
      source: {
        repository: "Clubedge/clubedge-starter",
        ref: "v1.0.0",
        files: ["package.json", "apps/web/package.json", "packages/contract/package.json"].map((path) => ({ from: path, to: path })),
      },
      manifest,
      stacks,
      cliVersion: "9.9.9",
      git: false,
      install: false,
    });

  it("keeps a slot's packages only when the slot is filled", () => {
    expect(plan({ framework: "vite", api: "fastapi" }).files.map(({ to }) => to)).toContain("packages/contract/package.json");
    expect(plan({ framework: "next" }).files.map(({ to }) => to)).not.toContain("packages/contract/package.json");
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
          "apps/api-python/src/config/site.json",
          "packages/contract/package.json",
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
      "apps/api/src/config/site.json",
      "packages/contract/package.json",
    ]);
    expect(plan.edits.map(({ path }) => path)).toContain("apps/api/src/config/site.json");
    expect(plan.envFiles).toEqual([
      { from: ".env.example", to: "apps/web/.env.local" },
      { from: "apps/api/.env.example", to: "apps/api/.env.local" },
    ]);
    // The API owns the database, so --infra neon writes its URLs there.
    expect(plan.databaseEnvFile).toBe("apps/api/.env.local");
    expect(plan.provenance.stacks).toEqual({ framework: "vite", api: "fastapi" });
    expect(describePlan(plan)).toContain("Install the FastAPI app's dependencies in apps/api with uv");
  });

  it("keeps the database in the API's env file when its example is missing", () => {
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
          "apps/api-python/Dockerfile",
          "apps/api-python/src/config/site.json",
          "packages/contract/package.json",
          "clubedge/modules/auth.json",
        ].map((path) => ({ from: path, to: path })),
      },
      manifest,
      stacks: { framework: "vite", api: "fastapi" },
      cliVersion: "9.9.9",
      git: false,
      install: true,
    });
    expect(plan.envFiles).toEqual([{ from: ".env.example", to: "apps/web/.env.local" }]);
    // Where databaseEnvFile(project) looks later, from the API's service.
    expect(plan.databaseEnvFile).toBe("apps/api/.env.local");
  });
});

/** Schema 5: the same Starter with a mobile shell, which packages the Vite frontend and runs no server. */
const shellRoot = {
  ...root,
  schemaVersion: 5,
  slots: {
    ...root.slots,
    shell: {
      name: "Mobile shell",
      question: "Package the web app as a mobile app?",
      path: "apps/shell",
      package: "@clubedge/shell",
      env: { example: "apps/shell/.env.example", target: "apps/shell/.env.local" },
      roles: ["shell"],
      siteConfig: "apps/shell/src/config/site.json",
    },
  },
};
const capacitor = {
  directory: "apps/capacitor",
  data: { id: "capacitor", name: "Capacitor", role: "shell", envExample: ".env.example" },
};
const deployed = ({ directory, data }: Packs["stacks"][number], id: string, port: number) => ({
  directory,
  data: { ...(data as object), deployment: { id, port, healthPath: "/api/health", platforms: ["docker", "railway"] } },
});
const shellStacks: Packs["stacks"] = [stacks[0]!, deployed(stacks[1]!, "web", 3000), deployed(stacks[2]!, "api", 3001), capacitor];
const shellPacks: Packs = { stacks: shellStacks, modules };
const shellManifest = parseTemplateManifest(JSON.stringify(shellRoot), shellPacks);
const withShell = (data: Record<string, unknown>) => [...shellStacks.slice(0, 3), { ...capacitor, data: { ...capacitor.data, ...data } }];
const mobile = { framework: "vite", api: "fastapi", shell: "capacitor" };

describe("schema 5 shells", () => {
  it("reads a shell and its slot, which have no Dockerfile or deployment", () => {
    expect(shellManifest.slots.shell).toEqual({
      name: "Mobile shell",
      question: "Package the web app as a mobile app?",
      path: "apps/shell",
      package: "@clubedge/shell",
      env: { example: "apps/shell/.env.example", target: "apps/shell/.env.local" },
      roles: ["shell"],
      siteConfig: "apps/shell/src/config/site.json",
      packages: {},
    });
    expect(shellManifest.stacks.capacitor).toEqual({
      name: "Capacitor",
      role: "shell",
      slot: "shell",
      app: "apps/capacitor",
      envExample: "apps/capacitor/.env.example",
      modules: {},
    });
  });

  it.each([
    ["a shell with a deployment", withShell({ deployment: { id: "mobile", port: 3000, healthPath: "/", platforms: ["docker"] } })],
    ["a shell with a Dockerfile", withShell({ dockerfile: "Dockerfile" })],
  ])("rejects %s", (_label, broken) => {
    expect(() => parseTemplateManifest(JSON.stringify(shellRoot), { stacks: broken, modules })).toThrow(
      "apps/capacitor/clubedge.stack.json: a shell runs no server, so it has no dockerfile or deployment.",
    );
  });

  it("still needs a Dockerfile for the apps that run a server", () => {
    const { dockerfile: _, ...frontend } = stacks[1]!.data as Record<string, unknown>;
    const broken = [stacks[0]!, { ...stacks[1]!, data: frontend }, capacitor];
    expect(() => parseTemplateManifest(JSON.stringify(shellRoot), { stacks: broken, modules })).toThrow(
      "apps/vite/clubedge.stack.json: dockerfile must be a non-empty string.",
    );
  });

  it("leaves the shell role to schema 5, so schema 4 reads as before", () => {
    expect(() => parseTemplateManifest(JSON.stringify({ ...shellRoot, schemaVersion: 4 }), shellPacks)).toThrow(
      "clubedge.template.json: slots.shell.roles must list one or more of: fullstack, frontend, api.",
    );
    expect(() => parseTemplateManifest(JSON.stringify(root), { stacks: [...stacks, capacitor], modules })).toThrow(
      "apps/capacitor/clubedge.stack.json: role must be one of: fullstack, frontend, api.",
    );
  });
});

describe("a project with a shell", () => {
  const plan = (selection: Record<string, string>) =>
    createPlan({
      targetDirectory: "/projects/my-product",
      identity: { packageName: "my-product", displayName: "My Product" },
      source: {
        repository: "Clubedge/clubedge-starter",
        ref: "v1.0.0",
        files: [
          "package.json",
          "README.md",
          "apps/vite/package.json",
          "apps/vite/.env.example",
          "apps/api-python/pyproject.toml",
          "apps/api-python/.env.example",
          "apps/capacitor/package.json",
          "apps/capacitor/.env.example",
          "apps/capacitor/capacitor.config.ts",
          "apps/capacitor/src/config/site.json",
        ].map((path) => ({ from: path, to: path })),
      },
      manifest: shellManifest,
      stacks: selection,
      cliVersion: "9.9.9",
      git: false,
      install: false,
    });

  it("places the shell in its slot, with its env file and site config", () => {
    const created = plan(mobile);
    expect(created.files.filter(({ from }) => from.startsWith("apps/capacitor/"))).toEqual([
      { from: "apps/capacitor/package.json", to: "apps/shell/package.json" },
      { from: "apps/capacitor/.env.example", to: "apps/shell/.env.example" },
      { from: "apps/capacitor/capacitor.config.ts", to: "apps/shell/capacitor.config.ts" },
      { from: "apps/capacitor/src/config/site.json", to: "apps/shell/src/config/site.json" },
    ]);
    expect(created.envFiles).toContainEqual({ from: "apps/shell/.env.example", to: "apps/shell/.env.local" });
    expect(describePlan(created)).toEqual(
      expect.arrayContaining([
        "Use React + Vite, FastAPI, and Capacitor",
        'Edit apps/shell/src/config/site.json: Set the project name to "My Product"',
      ]),
    );
    expect(created.provenance.stacks).toEqual(mobile);
    expect(plan({ framework: "vite", api: "fastapi" }).files.map(({ to }) => to)).not.toContain("apps/shell/package.json");
  });

  it("records only the apps that run a server as services, so deploy leaves the shell out", () => {
    const services = plan(mobile).provenance.services!;
    expect(Object.keys(services)).toEqual(["framework", "api"]);
    expect(dockerComposeSource("my-product", services)).not.toMatch(/shell|capacitor/);
    expect(railwayIacSource("my-product", services)).toContain("resources: [framework, api]");
  });

  it("keeps the sections marked for the shell", () => {
    const readme = [
      "# Clubedge Starter",
      "<!-- clubedge:if shell!=none -->",
      "Build the mobile app.",
      "<!-- clubedge:end -->",
      "- Web <!-- clubedge:only shell=none -->",
      "- Web and mobile <!-- clubedge:only shell=capacitor -->",
      "",
    ].join("\n");
    const edited = (selection: Record<string, string>) =>
      plan(selection).edits.filter(({ path }) => path === "README.md").reduce((text, { apply }) => apply(text), readme);
    expect(edited(mobile)).toContain("\nBuild the mobile app.\n- Web and mobile\n");
    expect(edited({ framework: "vite", api: "fastapi" })).not.toContain("mobile");
    expect(edited({ framework: "vite", api: "fastapi" })).toContain("\n- Web\n");
  });

  it("is created, read back, and rendered again as it was created", async () => {
    const starter = await temporaryDirectory();
    await writeFiles(starter, {
      "clubedge.template.json": JSON.stringify(shellRoot),
      "clubedge/modules/auth.json": JSON.stringify(modules.auth),
      "clubedge/modules/deploy.json": JSON.stringify(modules.deploy),
      ...Object.fromEntries(shellStacks.map(({ directory, data }) => [`${directory}/clubedge.stack.json`, JSON.stringify(data)])),
      "package.json": JSON.stringify({ name: "clubedge-starter" }),
      "README.md": "# Clubedge Starter\n",
      "apps/vite/package.json": JSON.stringify({ name: "@clubedge/vite" }),
      "apps/vite/.env.example": "VITE_API_URL=\n",
      "apps/vite/Dockerfile": "FROM node\n",
      "apps/api-python/package.json": JSON.stringify({ name: "@clubedge/api-python" }),
      "apps/api-python/.env.example": "DATABASE_URL=\n",
      "apps/api-python/Dockerfile": "FROM python\n",
      "apps/capacitor/package.json": JSON.stringify({ name: "@clubedge/capacitor" }),
      "apps/capacitor/.env.example": "VITE_API_URL=\n",
      "apps/capacitor/src/config/site.json": JSON.stringify(siteConfig),
    });
    const source = await readDirectoryTemplate(starter);
    const manifest = await readTemplateManifest(source.root);
    const root = join(await temporaryDirectory(), "my-product");
    const identity = { packageName: "my-product", displayName: "My Product" };
    await executePlan(
      createPlan({ targetDirectory: root, identity, source, manifest, stacks: mobile, cliVersion: "1.0.0", git: false, install: false }),
      source,
    );

    const read = (path: string) => readFile(join(root, path), "utf8");
    expect(JSON.parse(await read("apps/shell/package.json")).name).toBe("@clubedge/shell");
    expect(JSON.parse(await read("apps/shell/src/config/site.json")).name).toBe("My Product");
    expect(await read("apps/shell/.env.local")).toBe("VITE_API_URL=\n");
    expect(JSON.parse(await read("package.json")).clubedge).toMatchObject({ framework: "vite", apps: { api: "fastapi", shell: "capacitor" } });

    // add, remove, and upgrade render the project again from what it recorded.
    const project = await readProject(root);
    expect(project.stacks).toEqual(mobile);
    expect(Object.keys(project.services)).toEqual(["framework", "api"]);
    const { modules: selection, cliVersion } = project;
    const rendered = await renderProject({ source, manifest, identity: project.identity, stacks: project.stacks, modules: selection, cliVersion });
    for (const [path, content] of rendered.files) expect(await read(path)).toBe(content.toString("utf8"));
  });
});

describe("selecting a shell", () => {
  it("leaves the shell out by default", () => {
    expect(selectStacks(shellManifest)).toEqual({ framework: "next", api: "none", shell: "none" });
  });

  it("packages a frontend, which still needs its API", () => {
    expect(selectStacks(shellManifest, mobile)).toEqual(mobile);
    expect(() => selectStacks(shellManifest, { framework: "vite", shell: "capacitor" })).toThrow(
      "React + Vite is a frontend and calls an API: choose one with --api (fastapi).",
    );
  });

  it("cannot package a full-stack app, which renders its pages on its server", () => {
    expect(() => selectStacks(shellManifest, { shell: "capacitor" })).toThrow(
      "Next.js renders pages on its server, so Capacitor cannot package it: choose a frontend, or --shell none.",
    );
  });

  it("names the frontends it can package when none is chosen", () => {
    const { default: _, ...framework } = shellRoot.slots.framework;
    const optional = parseTemplateManifest(JSON.stringify({ ...shellRoot, slots: { ...shellRoot.slots, framework } }), shellPacks);
    expect(() => selectStacks(optional, { shell: "capacitor" })).toThrow(
      "Capacitor packages a frontend's static files: choose one with --framework (vite).",
    );
  });

  it("offers the shell after the framework and the API, only for a frontend", () => {
    expect(slotChoices(shellManifest, "framework")).toEqual(["next", "vite"]);
    expect(slotChoices(shellManifest, "framework", { shell: "capacitor" })).toEqual(["vite"]);
    expect(slotChoices(shellManifest, "api", { framework: "vite" })).toEqual(["fastapi"]);
    expect(slotChoices(shellManifest, "shell", { framework: "next", api: "none" })).toEqual(["none"]);
    expect(slotChoices(shellManifest, "shell", { framework: "vite", api: "fastapi" })).toEqual(["capacitor", "none"]);
  });

  it("is chosen with --shell and listed in the help", () => {
    const flags = parseCliArgs(["app", "--api", "fastapi", "--shell", "capacitor"]).modules;
    expect(splitSelection(shellManifest, "vite", flags)).toEqual({ stacks: mobile, modules: {} });
    expect(selectionHelp(shellManifest)).toContain("  --shell <id>            Mobile shell: capacitor or none (default)");
  });
});

/**
 * Schema 6: the same Starter with a mobile app, which has its own native screens, calls the API,
 * and runs no server. Its slot comes after the API's, so it is asked about once the API is known.
 */
const mobileRoot = {
  ...shellRoot,
  schemaVersion: 6,
  slots: {
    ...root.slots,
    mobile: {
      name: "Mobile app",
      question: "Add a native mobile app?",
      path: "apps/mobile",
      package: "@clubedge/mobile-app",
      env: { example: "apps/mobile/.env.example", target: "apps/mobile/.env.local" },
      roles: ["mobile"],
      siteConfig: "apps/mobile/src/config/site.json",
    },
    shell: shellRoot.slots.shell,
  },
};
const expo = { directory: "apps/expo", data: { id: "expo", name: "Expo", role: "mobile", envExample: ".env.example" } };
const mobileStacks: Packs["stacks"] = [...shellStacks, expo];
const mobilePacks: Packs = { stacks: mobileStacks, modules };
const mobileManifest = parseTemplateManifest(JSON.stringify(mobileRoot), mobilePacks);
const withExpo = (data: Record<string, unknown>) => [...shellStacks, { ...expo, data: { ...expo.data, ...data } }];
const native = { framework: "vite", api: "fastapi", mobile: "expo" };

describe("schema 6 mobile apps", () => {
  it("reads a mobile app and its slot, which have no Dockerfile or deployment", () => {
    expect(mobileManifest.slots.mobile).toEqual({
      name: "Mobile app",
      question: "Add a native mobile app?",
      path: "apps/mobile",
      package: "@clubedge/mobile-app",
      env: { example: "apps/mobile/.env.example", target: "apps/mobile/.env.local" },
      roles: ["mobile"],
      siteConfig: "apps/mobile/src/config/site.json",
      packages: {},
    });
    expect(mobileManifest.stacks.expo).toEqual({
      name: "Expo",
      role: "mobile",
      slot: "mobile",
      app: "apps/expo",
      envExample: "apps/expo/.env.example",
      modules: {},
    });
  });

  it.each([
    ["a mobile app with a deployment", withExpo({ deployment: { id: "mobile", port: 8081, healthPath: "/", platforms: ["docker"] } })],
    ["a mobile app with a Dockerfile", withExpo({ dockerfile: "Dockerfile" })],
  ])("rejects %s", (_label, broken) => {
    expect(() => parseTemplateManifest(JSON.stringify(mobileRoot), { stacks: broken, modules })).toThrow(
      "apps/expo/clubedge.stack.json: a mobile app runs no server, so it has no dockerfile or deployment.",
    );
  });

  it("reads the advisories pnpm audit skips for a stack's dependencies, from schema 6", () => {
    const advisories = ["GHSA-86w9-cpqp-85rv", "GHSA-mrhx-c7xc-m3w5"];
    const read = (stacks: Packs["stacks"], manifest: object = mobileRoot) => parseTemplateManifest(JSON.stringify(manifest), { stacks, modules });

    expect(read(withExpo({ auditIgnores: advisories })).stacks.expo!.auditIgnores).toEqual(advisories);
    expect(() => read(withExpo({ auditIgnores: ["CVE-2026-0001"] }))).toThrow(
      'apps/expo/clubedge.stack.json: auditIgnores: "CVE-2026-0001" is not a GitHub advisory id, such as GHSA-xxxx-xxxx-xxxx.',
    );
    for (const listed of [advisories, []]) {
      expect(() => read(withShell({ auditIgnores: listed }), shellRoot)).toThrow(
        "apps/capacitor/clubedge.stack.json: auditIgnores needs template schema 6.",
      );
    }
  });

  it("leaves the mobile role to schema 6, so schema 5 reads as before", () => {
    expect(() => parseTemplateManifest(JSON.stringify({ ...mobileRoot, schemaVersion: 5 }), mobilePacks)).toThrow(
      "clubedge.template.json: slots.mobile.roles must list one or more of: fullstack, frontend, api, shell.",
    );
    expect(() => parseTemplateManifest(JSON.stringify(shellRoot), { stacks: mobileStacks, modules })).toThrow(
      "apps/expo/clubedge.stack.json: role must be one of: fullstack, frontend, api, shell.",
    );
  });
});

describe("a project with a mobile app", () => {
  const plan = (selection: Record<string, string>, manifest = mobileManifest) =>
    createPlan({
      targetDirectory: "/projects/my-product",
      identity: { packageName: "my-product", displayName: "My Product" },
      source: {
        repository: "Clubedge/clubedge-starter",
        ref: "v1.0.0",
        files: [
          "package.json",
          "README.md",
          "apps/vite/package.json",
          "apps/vite/.env.example",
          "apps/api-python/pyproject.toml",
          "apps/api-python/.env.example",
          "apps/capacitor/package.json",
          "apps/expo/package.json",
          "apps/expo/.env.example",
          "apps/expo/app.config.ts",
          "apps/expo/src/config/site.json",
        ].map((path) => ({ from: path, to: path })),
      },
      manifest,
      stacks: selection,
      cliVersion: "9.9.9",
      git: false,
      install: false,
    });

  it("places the mobile app in its slot, with its env file and site config", () => {
    const created = plan(native);
    expect(created.files.filter(({ from }) => from.startsWith("apps/expo/"))).toEqual([
      { from: "apps/expo/package.json", to: "apps/mobile/package.json" },
      { from: "apps/expo/.env.example", to: "apps/mobile/.env.example" },
      { from: "apps/expo/app.config.ts", to: "apps/mobile/app.config.ts" },
      { from: "apps/expo/src/config/site.json", to: "apps/mobile/src/config/site.json" },
    ]);
    expect(created.envFiles).toContainEqual({ from: "apps/mobile/.env.example", to: "apps/mobile/.env.local" });
    expect(describePlan(created)).toEqual(
      expect.arrayContaining([
        "Use React + Vite, FastAPI, and Expo",
        'Edit apps/mobile/src/config/site.json: Set the project name to "My Product"',
      ]),
    );
    expect(created.provenance.stacks).toEqual(native);
    expect(plan({ framework: "vite", api: "fastapi" }).files.map(({ to }) => to)).not.toContain("apps/mobile/package.json");
  });

  it("sits next to a shell, which packages the same frontend", () => {
    const both = plan({ ...native, shell: "capacitor" });
    expect(both.files.map(({ to }) => to)).toEqual(expect.arrayContaining(["apps/mobile/package.json", "apps/shell/package.json"]));
  });

  it("records only the apps that run a server as services, so deploy leaves the mobile app out", () => {
    const services = plan(native).provenance.services!;
    expect(Object.keys(services)).toEqual(["framework", "api"]);
    expect(dockerComposeSource("my-product", services)).not.toMatch(/\b(mobile|expo)\b/);
    expect(railwayIacSource("my-product", services)).toContain("resources: [framework, api]");
  });

  it("audits again, without the mobile app, the advisories only it needs pnpm audit to skip", () => {
    const advisories = ["GHSA-86w9-cpqp-85rv", "GHSA-mrhx-c7xc-m3w5"];
    const manifest = parseTemplateManifest(JSON.stringify(mobileRoot), { stacks: withExpo({ auditIgnores: advisories }), modules });
    const starter = JSON.stringify({ name: "clubedge-starter", pnpm: { auditConfig: { ignoreGhsas: advisories } } });
    const pnpm = (selection: Record<string, string>) =>
      JSON.parse(plan(selection, manifest).edits.filter(({ path }) => path === "package.json").reduce((text, { apply }) => apply(text), starter)).pnpm;

    expect(pnpm(native)).toEqual({ auditConfig: { ignoreGhsas: advisories } });
    expect(pnpm({ framework: "vite", api: "fastapi" })).toBeUndefined();
  });

  it("keeps the sections marked for the mobile app", () => {
    const readme = [
      "# Clubedge Starter",
      "<!-- clubedge:if mobile!=none -->",
      "Build the native app.",
      "<!-- clubedge:end -->",
      "- Web <!-- clubedge:only mobile=none -->",
      "- Web and native <!-- clubedge:only mobile=expo -->",
      "",
    ].join("\n");
    const edited = (selection: Record<string, string>) =>
      plan(selection).edits.filter(({ path }) => path === "README.md").reduce((text, { apply }) => apply(text), readme);
    expect(edited(native)).toContain("\nBuild the native app.\n- Web and native\n");
    expect(edited({ framework: "vite", api: "fastapi" })).not.toContain("native");
    expect(edited({ framework: "vite", api: "fastapi" })).toContain("\n- Web\n");
  });

  it("is created, read back, and rendered again as it was created", async () => {
    const starter = await temporaryDirectory();
    await writeFiles(starter, {
      "clubedge.template.json": JSON.stringify(mobileRoot),
      "clubedge/modules/auth.json": JSON.stringify(modules.auth),
      "clubedge/modules/deploy.json": JSON.stringify(modules.deploy),
      ...Object.fromEntries(mobileStacks.map(({ directory, data }) => [`${directory}/clubedge.stack.json`, JSON.stringify(data)])),
      "package.json": JSON.stringify({ name: "clubedge-starter" }),
      "README.md": "# Clubedge Starter\n",
      "apps/vite/package.json": JSON.stringify({ name: "@clubedge/vite" }),
      "apps/vite/.env.example": "VITE_API_URL=\n",
      "apps/vite/Dockerfile": "FROM node\n",
      "apps/api-python/package.json": JSON.stringify({ name: "@clubedge/api-python" }),
      "apps/api-python/.env.example": "DATABASE_URL=\n",
      "apps/api-python/Dockerfile": "FROM python\n",
      "apps/capacitor/package.json": JSON.stringify({ name: "@clubedge/capacitor" }),
      "apps/capacitor/.env.example": "WEB_URL=\n",
      "apps/expo/package.json": JSON.stringify({ name: "@clubedge/expo" }),
      "apps/expo/.env.example": "EXPO_PUBLIC_API_URL=\n",
      "apps/expo/src/config/site.json": JSON.stringify(siteConfig),
    });
    const source = await readDirectoryTemplate(starter);
    const manifest = await readTemplateManifest(source.root);
    const root = join(await temporaryDirectory(), "my-product");
    const identity = { packageName: "my-product", displayName: "My Product" };
    await executePlan(
      createPlan({ targetDirectory: root, identity, source, manifest, stacks: native, cliVersion: "1.0.0", git: false, install: false }),
      source,
    );

    const read = (path: string) => readFile(join(root, path), "utf8");
    expect(JSON.parse(await read("apps/mobile/package.json")).name).toBe("@clubedge/mobile-app");
    expect(JSON.parse(await read("apps/mobile/src/config/site.json")).name).toBe("My Product");
    expect(await read("apps/mobile/.env.local")).toBe("EXPO_PUBLIC_API_URL=\n");
    expect(JSON.parse(await read("package.json")).clubedge).toMatchObject({ framework: "vite", apps: { api: "fastapi", mobile: "expo" } });

    // add, remove, and upgrade render the project again from what it recorded.
    const project = await readProject(root);
    expect(project.stacks).toEqual(native);
    expect(Object.keys(project.services)).toEqual(["framework", "api"]);
    const { modules: selection, cliVersion } = project;
    const rendered = await renderProject({ source, manifest, identity: project.identity, stacks: project.stacks, modules: selection, cliVersion });
    for (const [path, content] of rendered.files) expect(await read(path)).toBe(content.toString("utf8"));
  });
});

describe("selecting a mobile app", () => {
  it("leaves the mobile app out by default", () => {
    expect(selectStacks(mobileManifest)).toEqual({ framework: "next", api: "none", mobile: "none", shell: "none" });
  });

  it("calls the API, next to a frontend, and next to a shell too", () => {
    expect(selectStacks(mobileManifest, native)).toEqual({ ...native, shell: "none" });
    expect(selectStacks(mobileManifest, { ...native, shell: "capacitor" })).toEqual({ ...native, shell: "capacitor" });
  });

  it("needs an API, which a full-stack app does not have apart from its pages", () => {
    expect(() => selectStacks(mobileManifest, { mobile: "expo" })).toThrow(
      "Next.js has no separate API for Expo to call: choose a frontend with an API, or --mobile none.",
    );
    const { default: _, ...framework } = mobileRoot.slots.framework;
    const optional = parseTemplateManifest(JSON.stringify({ ...mobileRoot, slots: { ...mobileRoot.slots, framework } }), mobilePacks);
    expect(() => selectStacks(optional, { mobile: "expo" })).toThrow("Expo is a mobile app and calls an API: choose one with --api (fastapi).");
  });

  it("is offered after the framework and the API, only with an API", () => {
    expect(slotChoices(mobileManifest, "framework", { mobile: "expo" })).toEqual(["vite"]);
    expect(slotChoices(mobileManifest, "mobile", { framework: "next", api: "none" })).toEqual(["none"]);
    expect(slotChoices(mobileManifest, "mobile", { framework: "vite", api: "fastapi" })).toEqual(["expo", "none"]);
  });

  it("is chosen with --mobile and listed in the help", () => {
    const flags = parseCliArgs(["app", "--api", "fastapi", "--mobile", "expo"]).modules;
    expect(splitSelection(mobileManifest, "vite", flags)).toEqual({ stacks: native, modules: {} });
    expect(selectionHelp(mobileManifest)).toMatch(/\n {2}--mobile <id> +Mobile app: expo or none \(default\)/);
  });
});

/**
 * Schema 6 also lets a slot with a default be left empty: a project that is only an API and a
 * mobile app has no web app, so the Starter's framework slot says it is optional.
 */
const apiOnlyRoot = {
  ...mobileRoot,
  slots: { ...mobileRoot.slots, framework: { ...mobileRoot.slots.framework, optional: true } },
};
const apiOnlyManifest = parseTemplateManifest(JSON.stringify(apiOnlyRoot), mobilePacks);
const apiOnly = { framework: "none", api: "fastapi", mobile: "expo" };

describe("a project without a web app", () => {
  it("reads a slot with a default that can still be left empty, from schema 6", () => {
    expect(apiOnlyManifest.slots.framework).toMatchObject({ default: "next", optional: true });
    expect(selectStacks(apiOnlyManifest).framework).toBe("next");
    const optionalShellRoot = {
      ...shellRoot,
      slots: { ...shellRoot.slots, framework: { ...shellRoot.slots.framework, optional: true } },
    };
    expect(() => parseTemplateManifest(JSON.stringify(optionalShellRoot), shellPacks)).toThrow(
      "clubedge.template.json: slots.framework.optional needs template schema 6.",
    );
  });

  it("leaves the web app out with --framework none, and still needs an API", () => {
    expect(selectStacks(apiOnlyManifest, apiOnly)).toEqual({ ...apiOnly, shell: "none" });
    expect(selectStacks(apiOnlyManifest, { framework: "none", api: "fastapi" })).toEqual({
      framework: "none",
      api: "fastapi",
      mobile: "none",
      shell: "none",
    });
    expect(() => selectStacks(apiOnlyManifest, { framework: "none" })).toThrow(
      "A project needs a web app or an API: choose one with --framework or --api.",
    );
    expect(() => selectStacks(apiOnlyManifest, { framework: "none", mobile: "expo" })).toThrow(
      "Expo is a mobile app and calls an API: choose one with --api (fastapi).",
    );
    expect(() => selectStacks(apiOnlyManifest, { framework: "none", api: "fastapi", shell: "capacitor" })).toThrow(
      "Capacitor packages a frontend's static files: choose one with --framework (vite).",
    );
    // Without the optional flag, none is not a framework.
    expect(() => selectStacks(mobileManifest, apiOnly)).toThrow('Unknown framework "none". This Starter offers: next, vite.');
  });

  it("offers none as a framework, then only the API it needs, and lists it in the help", () => {
    expect(slotChoices(apiOnlyManifest, "framework")).toEqual(["next", "vite", "none"]);
    expect(slotChoices(apiOnlyManifest, "api", { framework: "none" })).toEqual(["fastapi"]);
    expect(selectionHelp(apiOnlyManifest)).toMatch(/--framework <id> +Framework: next \(default\), vite, or none/);
  });

  it("records the framework as none, so add, remove, and upgrade leave the web app out", async () => {
    const starter = await temporaryDirectory();
    await writeFiles(starter, {
      "clubedge.template.json": JSON.stringify(apiOnlyRoot),
      "clubedge/modules/auth.json": JSON.stringify(modules.auth),
      "clubedge/modules/deploy.json": JSON.stringify(modules.deploy),
      ...Object.fromEntries(mobileStacks.map(({ directory, data }) => [`${directory}/clubedge.stack.json`, JSON.stringify(data)])),
      "package.json": JSON.stringify({ name: "clubedge-starter" }),
      "README.md": "# Clubedge Starter\n",
      ".env.example": "NEXT_PUBLIC_SITE_URL=\n",
      Dockerfile: "FROM node\n",
      "apps/web/package.json": JSON.stringify({ name: "@clubedge/web" }),
      "apps/web/src/config/site.json": JSON.stringify(siteConfig),
      "apps/vite/package.json": JSON.stringify({ name: "@clubedge/vite" }),
      "apps/vite/.env.example": "VITE_API_URL=\n",
      "apps/vite/Dockerfile": "FROM node\n",
      "apps/api-python/package.json": JSON.stringify({ name: "@clubedge/api-python" }),
      "apps/api-python/.env.example": "DATABASE_URL=\n",
      "apps/api-python/Dockerfile": "FROM python\n",
      "apps/capacitor/package.json": JSON.stringify({ name: "@clubedge/capacitor" }),
      "apps/expo/package.json": JSON.stringify({ name: "@clubedge/expo" }),
      "apps/expo/.env.example": "EXPO_PUBLIC_API_URL=\n",
      "apps/expo/src/config/site.json": JSON.stringify(siteConfig),
    });
    const source = await readDirectoryTemplate(starter);
    const manifest = await readTemplateManifest(source.root);
    const root = join(await temporaryDirectory(), "my-product");
    const identity = { packageName: "my-product", displayName: "My Product" };
    const plan = createPlan({ targetDirectory: root, identity, source, manifest, stacks: apiOnly, cliVersion: "1.0.0", git: false, install: false });
    expect(plan.provenance.stacks).toEqual(apiOnly);
    expect(plan.provenance.stackSummary).toEqual(["Framework: none", "API: FastAPI", "Mobile app: Expo"]);
    await executePlan(plan, source);

    const exists = (path: string) => access(join(root, path)).then(() => true, () => false);
    expect(await exists("apps/web")).toBe(false);
    expect(await exists(".env.example")).toBe(false);
    expect(await exists("Dockerfile")).toBe(false);
    expect(await exists("apps/api/.env.local")).toBe(true);
    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8")).clubedge).toMatchObject({
      framework: "none",
      apps: { api: "fastapi", mobile: "expo" },
    });

    // add, remove, and upgrade render the project again from what it recorded.
    const project = await readProject(root);
    expect(project.stacks).toEqual(apiOnly);
    expect(projectEnvFiles(project).map(({ local }) => local)).toEqual(["apps/api/.env.local"]);
    const { modules: selection, cliVersion } = project;
    const rendered = await renderProject({ source, manifest, identity: project.identity, stacks: project.stacks, modules: selection, cliVersion });
    for (const [path, content] of rendered.files) expect(await readFile(join(root, path), "utf8")).toBe(content.toString("utf8"));
  });
});
