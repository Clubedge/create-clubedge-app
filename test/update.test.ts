import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executePlan } from "../src/core/execute.js";
import { readTemplateManifest } from "../src/core/manifest.js";
import { createPlan } from "../src/core/plan.js";
import { ProjectError, readProject } from "../src/core/project.js";
import { readDirectoryTemplate } from "../src/core/source.js";
import { applyUpdate, INCOMING_DIR, incomingFiles, planUpdate, type UpdatePlan } from "../src/core/update.js";
import { changedModules, completeCommand, upgradedModules } from "../src/modify.js";
import { pathExists } from "../src/utils/fs.js";
import { moduleStarterFiles, temporaryDirectory, writeFiles } from "./helpers.js";

/** A project generated from the modules fixture, plus a function that changes its modules. */
async function generatedProject(modules: Record<string, string> = {}) {
  const starter = await temporaryDirectory();
  await writeFiles(starter, moduleStarterFiles());
  const source = await readDirectoryTemplate(starter);
  const manifest = await readTemplateManifest(source.root);
  const root = join(await temporaryDirectory(), "my-product");
  await executePlan(
    createPlan({
      targetDirectory: root,
      identity: { packageName: "my-product", displayName: "My Product" },
      source,
      manifest,
      stacks: { framework: "next" },
      modules,
      cliVersion: "1.0.0",
      git: false,
      install: false,
    }),
    source,
  );

  async function change(update: Record<string, string>) {
    const project = await readProject(join(root, "apps/web"));
    const plan = await planUpdate(
      project,
      { source, manifest, modules: project.modules, cliVersion: project.cliVersion },
      { source, manifest, modules: { ...project.modules, ...update }, cliVersion: "2.0.0" },
    );
    await applyUpdate(plan);
    return plan;
  }

  const read = (path: string) => readFile(join(root, path), "utf8");
  const write = (path: string, content: string) => writeFile(join(root, path), content);
  const exists = (path: string) => pathExists(join(root, path));
  return { root, change, read, write, exists };
}

describe("readProject", () => {
  it("finds the project from a nested folder and reads its provenance", async () => {
    const { root } = await generatedProject();
    const project = await readProject(join(root, "apps/web/src"));
    expect(project).toMatchObject({
      root,
      identity: { packageName: "my-product", displayName: "My Product" },
      cliVersion: "1.0.0",
      stacks: { framework: "next" },
      modules: { auth: "supabase", storage: "s3" },
    });
  });

  it("reads a project that recorded only an optional app, without a framework", async () => {
    const root = await temporaryDirectory();
    const clubedge = { cliVersion: "2.0.0", starterRepository: "r", starterRef: "v1", apps: { api: "fastapi" }, modules: { auth: "none" } };
    await writeFiles(root, { "package.json": JSON.stringify({ name: "my-product", clubedge }) });
    expect(await readProject(root)).toMatchObject({ stacks: { api: "fastapi" }, modules: { auth: "none" } });
  });

  it("refuses projects that predate recorded modules", async () => {
    const root = await temporaryDirectory();
    const clubedge = { cliVersion: "0.4.0", starterRepository: "r", starterRef: "v0.4.0", framework: "next" };
    await writeFiles(root, { "package.json": JSON.stringify({ name: "my-product", clubedge }) });
    await expect(readProject(root)).rejects.toThrow("before create-clubedge-app 0.5.0");
  });

  it("explains when there is no generated project", async () => {
    await expect(readProject(await temporaryDirectory())).rejects.toThrow("No Clubedge project found");
  });

  /** package.json after an upgrade whose version line both sides changed, as in issue #111. */
  const conflicted = (manifest: string) =>
    manifest.replace(/"name": "my-product",\n/, '"name": "my-product",\n<<<<<<< yours\n  "version": "1.0.0",\n=======\n  "version": "0.25.0",\n>>>>>>> clubedge\n');

  it("names a package.json with conflict markers and the Starter's version to compare it with", async () => {
    const { root, read, write } = await generatedProject();
    const manifest = await read("package.json");
    await write("package.json", conflicted(manifest));
    await writeFiles(join(root, INCOMING_DIR), { "package.json": manifest });

    const error = await readProject(root).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ProjectError);
    expect((error as Error).message).toContain("package.json has 1 unresolved conflict from an earlier add, remove, or upgrade");
    expect((error as Error).message).toContain("`pnpm install` and `pnpm clubedge` fail too");
    expect((error as Error).message).toContain("git diff --no-index package.json .clubedge/incoming/package.json");
  });

  it("names the conflicted file as seen from a nested folder, and leaves out a deleted incoming folder", async () => {
    const { root, read, write } = await generatedProject();
    await write("package.json", conflicted(await read("package.json")));
    const error = (await readProject(join(root, "apps/web")).catch((error: unknown) => error)) as Error;
    expect(error.message).toMatch(/^\.\.\/\.\.\/package\.json has 1 unresolved conflict/);
    expect(error.message).not.toContain("git diff --no-index");
  });

  it("finds the Starter's version of a conflicted workspace package.json", async () => {
    const { root, write } = await generatedProject();
    await write("apps/web/package.json", '{\n<<<<<<< yours\n  "name": "web"\n=======\n  "name": "@clubedge/web"\n>>>>>>> clubedge\n}\n');
    await writeFiles(join(root, INCOMING_DIR), { "apps/web/package.json": '{ "name": "@clubedge/web" }\n' });
    await expect(readProject(join(root, "apps/web"))).rejects.toThrow(
      "git diff --no-index package.json ../../.clubedge/incoming/apps/web/package.json",
    );
  });

  it("names a package.json that is not valid JSON for another reason", async () => {
    const { root, read, write } = await generatedProject();
    await write("package.json", (await read("package.json")).replace('"name": "my-product",', '"name": "my-product",,'));
    await expect(readProject(root)).rejects.toThrow(/^package\.json is not valid JSON: .+\. Fix it, then run this again\.$/);
  });
});

describe("planUpdate and applyUpdate", () => {
  it("removes a module's files, package, dependency, and env variable from an untouched project", async () => {
    const project = await generatedProject();
    const plan = await project.change({ storage: "none" });

    expect(await project.exists("apps/web/src/server/storage.ts")).toBe(false);
    expect(await project.exists("packages/storage-s3")).toBe(false);
    expect(JSON.parse(await project.read("apps/web/package.json")).dependencies).toEqual({
      "@clubedge/auth-supabase": "workspace:*",
    });
    expect(await project.read(".env.example")).not.toContain("STORAGE_BUCKET");
    expect(JSON.parse(await project.read("package.json")).clubedge).toMatchObject({
      cliVersion: "2.0.0",
      modules: { auth: "supabase", storage: "none" },
    });
    expect(plan.lockfile.kind).toBe("replace");
    expect(await project.read("pnpm-lock.yaml")).not.toContain("packages/storage-s3:");
    expect(plan.envs).toMatchObject([{ path: "apps/web/.env.local", update: { removed: ["STORAGE_BUCKET"] } }]);
  });

  it("keeps the project's edits and marks lines both sides changed", async () => {
    const project = await generatedProject();
    await project.write("apps/web/src/server/auth.ts", "export const provider = 'supabase'; // mine\n");
    await project.write("README.md", `${await project.read("README.md")}\nMy own notes.\n`);

    const plan = await project.change({ auth: "none", storage: "none" });

    expect(plan.actions.find((action) => action.path === "apps/web/src/server/auth.ts")?.kind).toBe("conflict");
    expect(await project.read("apps/web/src/server/auth.ts")).toBe(
      "<<<<<<< yours\nexport const provider = 'supabase'; // mine\n=======\nexport const provider = 'none';\n>>>>>>> clubedge\n",
    );
    const readme = await project.read("README.md");
    expect(readme).not.toContain("Supabase setup.");
    expect(readme).toContain("My own notes.");
    expect(await project.exists("apps/web/src/app/login/page.tsx")).toBe(false);
  });

  it("keeps a changed file the new selection drops, and leaves the project's own files alone", async () => {
    const project = await generatedProject();
    await project.write("apps/web/src/server/storage.ts", "export const storage = 's3'; // customized\n");
    await project.write("apps/web/src/server/billing.ts", "export const billing = true;\n");

    const plan = await project.change({ storage: "none" });

    expect(plan.actions.find((action) => action.path === "apps/web/src/server/storage.ts")?.kind).toBe("keep");
    expect(await project.read("apps/web/src/server/storage.ts")).toContain("customized");
    expect(await project.read("apps/web/src/server/billing.ts")).toBe("export const billing = true;\n");
  });

  it("appends new variables to the local env file without touching the existing values", async () => {
    const project = await generatedProject({ storage: "none" });
    await project.write("apps/web/.env.local", "DATABASE_URL=postgres://secret\nSUPABASE_URL=https://mine\n");

    const plan = await project.change({ storage: "s3" });

    expect(plan.envs[0]?.update?.added).toEqual(["STORAGE_BUCKET"]);
    expect(await project.read("apps/web/.env.local")).toBe(
      "DATABASE_URL=postgres://secret\nSUPABASE_URL=https://mine\n\nSTORAGE_BUCKET=\n",
    );
    expect(await project.exists("packages/storage-s3/package.json")).toBe(true);
  });

  it("asks for an install when the project changed its lockfile", async () => {
    const project = await generatedProject();
    await project.write("pnpm-lock.yaml", `${await project.read("pnpm-lock.yaml")}\n# changed by pnpm add\n`);

    const plan = await project.change({ storage: "none" });

    expect(plan.lockfile.kind).toBe("install");
    expect(await project.read("pnpm-lock.yaml")).toContain("# changed by pnpm add");
  });

  it("undoes itself: removing then adding a module restores the generated project", async () => {
    const project = await generatedProject();
    const before = await project.read("apps/web/package.json");
    await project.change({ storage: "none" });
    await project.change({ storage: "s3" });

    expect(await project.read("apps/web/package.json")).toBe(before);
    expect(await project.read("apps/web/src/server/storage.ts")).toBe("export const storage = 's3';\n");
  });
});

describe("upgrading to a newer Starter", () => {
  /** v1 is the modules fixture; v2 changes a file, adds one, and introduces a cache module. */
  async function twoRevisions() {
    const v1 = await temporaryDirectory();
    await writeFiles(v1, moduleStarterFiles());
    const v2 = await temporaryDirectory();
    const v2Manifest = {
      ...JSON.parse(moduleStarterFiles()["clubedge.template.json"]!),
      modules: {
        ...JSON.parse(moduleStarterFiles()["clubedge.template.json"]!).modules,
        cache: {
          name: "Cache",
          default: "redis",
          options: { redis: { name: "Redis", files: ["apps/web/src/server/cache.ts"] }, none: { name: "None" } },
        },
      },
    };
    await writeFiles(v2, {
      ...moduleStarterFiles(),
      "clubedge.template.json": JSON.stringify(v2Manifest),
      "apps/web/src/server/auth.ts": "export const provider = 'supabase';\nexport const version = 2;\n",
      "apps/web/src/server/cache.ts": "export const cache = 'redis';\n",
      "apps/web/src/server/health.ts": "export const healthy = true;\n",
    });
    return { v1: await readDirectoryTemplate(v1), v2: await readDirectoryTemplate(v2) };
  }

  it("brings the Starter's changes into an edited project and keeps new modules off", async () => {
    const { v1, v2 } = await twoRevisions();
    const root = join(await temporaryDirectory(), "my-product");
    const v1Manifest = await readTemplateManifest(v1.root);
    await executePlan(
      createPlan({
        targetDirectory: root,
        identity: { packageName: "my-product", displayName: "My Product" },
        source: { ...v1, ref: "v1.0.0", commit: "1".repeat(40) },
        manifest: v1Manifest,
        stacks: { framework: "next" },
        cliVersion: "1.0.0",
        git: false,
        install: false,
      }),
      v1,
    );
    await writeFile(join(root, "apps/web/src/server/storage.ts"), "export const storage = 's3'; // mine\n");

    const project = await readProject(root);
    const v2Manifest = await readTemplateManifest(v2.root);
    const { modules, introduced } = upgradedModules(v2Manifest, project);
    expect(introduced).toEqual(["cache"]);
    expect(modules).toEqual({ auth: "supabase", storage: "s3", cache: "none" });

    const plan = await planUpdate(
      project,
      { source: { ...v1, ref: project.starterRef, commit: project.starterCommit }, manifest: v1Manifest, modules: project.modules, cliVersion: project.cliVersion },
      { source: { ...v2, ref: "v2.0.0", commit: "2".repeat(40) }, manifest: v2Manifest, modules, cliVersion: "2.0.0" },
    );
    await applyUpdate(plan);

    const read = (path: string) => readFile(join(root, path), "utf8");
    expect(await read("apps/web/src/server/auth.ts")).toContain("export const version = 2;");
    expect(await read("apps/web/src/server/health.ts")).toBe("export const healthy = true;\n");
    expect(await read("apps/web/src/server/storage.ts")).toContain("// mine");
    expect(await pathExists(join(root, "apps/web/src/server/cache.ts"))).toBe(false);
    expect(JSON.parse(await read("package.json")).clubedge).toMatchObject({
      cliVersion: "2.0.0",
      starterRef: "v2.0.0",
      starterCommit: "2".repeat(40),
      modules: { auth: "supabase", storage: "s3", cache: "none" },
    });
    // The provenance lines match the project, so they update without conflicts.
    expect(plan.actions.filter((action) => action.kind === "conflict")).toEqual([]);
  });

  it("preserves a customized project version across Starter upgrades without conflicts", async () => {
    const { v1, v2 } = await twoRevisions();
    const root = join(await temporaryDirectory(), "versioned-product");
    const v1Manifest = await readTemplateManifest(v1.root);
    await executePlan(
      createPlan({
        targetDirectory: root,
        identity: { packageName: "versioned-product", displayName: "Versioned Product" },
        source: { ...v1, ref: "v1.0.0", commit: "1".repeat(40) },
        manifest: v1Manifest,
        stacks: { framework: "next" },
        cliVersion: "1.0.0",
        git: false,
        install: false,
      }),
      v1,
    );

    const pkgPath = join(root, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    pkg.version = "1.2.3";
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

    const project = await readProject(root);
    expect(project.identity.version).toBe("1.2.3");

    const v2Manifest = await readTemplateManifest(v2.root);
    const { modules } = upgradedModules(v2Manifest, project);
    const plan = await planUpdate(
      project,
      { source: { ...v1, ref: project.starterRef, commit: project.starterCommit }, manifest: v1Manifest, modules: project.modules, cliVersion: project.cliVersion },
      { source: { ...v2, ref: "v2.0.0", commit: "2".repeat(40) }, manifest: v2Manifest, modules, cliVersion: "2.0.0" },
    );
    await applyUpdate(plan);

    const updatedPkg = JSON.parse(await readFile(pkgPath, "utf8"));
    expect(updatedPkg.version).toBe("1.2.3");
    expect(plan.actions.find((action) => action.path === "package.json")?.kind).not.toBe("conflict");
  });

  it("preserves a customized workspace app version across Starter upgrades without conflicts", async () => {
    const { v1, v2 } = await twoRevisions();
    const root = join(await temporaryDirectory(), "versioned-app-product");
    const v1Manifest = await readTemplateManifest(v1.root);
    await executePlan(
      createPlan({
        targetDirectory: root,
        identity: { packageName: "versioned-app-product", displayName: "Versioned App Product" },
        source: { ...v1, ref: "v1.0.0", commit: "1".repeat(40) },
        manifest: v1Manifest,
        stacks: { framework: "next" },
        cliVersion: "1.0.0",
        git: false,
        install: false,
      }),
      v1,
    );

    const appPkgPath = join(root, "apps", "web", "package.json");
    const appPkg = JSON.parse(await readFile(appPkgPath, "utf8"));
    appPkg.version = "2.0.0";
    await writeFile(appPkgPath, JSON.stringify(appPkg, null, 2) + "\n");

    const project = await readProject(root);
    expect(project.identity.appVersions?.["apps/web"]).toBe("2.0.0");

    const v2Manifest = await readTemplateManifest(v2.root);
    const { modules } = upgradedModules(v2Manifest, project);
    const plan = await planUpdate(
      project,
      { source: { ...v1, ref: project.starterRef, commit: project.starterCommit }, manifest: v1Manifest, modules: project.modules, cliVersion: project.cliVersion },
      { source: { ...v2, ref: "v2.0.0", commit: "2".repeat(40) }, manifest: v2Manifest, modules, cliVersion: "2.0.0" },
    );
    await applyUpdate(plan);

    const updatedAppPkg = JSON.parse(await readFile(appPkgPath, "utf8"));
    expect(updatedAppPkg.version).toBe("2.0.0");
    expect(plan.actions.find((action) => action.path === "apps/web/package.json")?.kind).not.toBe("conflict");
  });

  it("keeps a custom README untouched and saves the new Starter's README to .clubedge/incoming", async () => {
    const { v1, v2 } = await twoRevisions();
    const root = join(await temporaryDirectory(), "custom-readme-product");
    const v1Manifest = await readTemplateManifest(v1.root);
    await executePlan(
      createPlan({
        targetDirectory: root,
        identity: { packageName: "custom-readme-product", displayName: "Custom Readme Product" },
        source: { ...v1, ref: "v1.0.0", commit: "1".repeat(40) },
        manifest: v1Manifest,
        stacks: { framework: "next" },
        cliVersion: "1.0.0",
        git: false,
        install: false,
      }),
      v1,
    );

    const customDocs = "# Custom Application\n\nThis is my own product documentation.\n";
    await writeFile(join(root, "README.md"), customDocs);

    const project = await readProject(root);
    const v2Manifest = await readTemplateManifest(v2.root);
    const { modules } = upgradedModules(v2Manifest, project);
    const plan = await planUpdate(
      project,
      { source: { ...v1, ref: project.starterRef, commit: project.starterCommit }, manifest: v1Manifest, modules: project.modules, cliVersion: project.cliVersion },
      { source: { ...v2, ref: "v2.0.0", commit: "2".repeat(40) }, manifest: v2Manifest, modules, cliVersion: "2.0.0" },
    );

    const readmeAction = plan.actions.find((action) => action.path === "README.md");
    expect(readmeAction).toMatchObject({
      kind: "keep",
      reason: "You replaced the generated README with your own.",
    });

    await applyUpdate(plan);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe(customDocs);
    expect(await readFile(join(root, INCOMING_DIR, "README.md"), "utf8")).toContain("# Custom Readme Product");
  });

  it("refuses an option the new Starter no longer offers", async () => {
    const { v2 } = await twoRevisions();
    const manifest = await readTemplateManifest(v2.root);
    const project = { modules: { auth: "magic-link", storage: "s3" } } as unknown as Parameters<typeof upgradedModules>[1];
    expect(() => upgradedModules(manifest, project)).toThrow('no longer offers Authentication "magic-link"');
  });
});

describe("completeCommand", () => {
  it("passes complete commands through and explains missing arguments without a terminal", async () => {
    const starter = await temporaryDirectory();
    await writeFiles(starter, moduleStarterFiles());
    const manifest = await readTemplateManifest(starter);
    const project = { modules: { auth: "supabase", storage: "s3" } } as unknown as Parameters<typeof completeCommand>[1];

    const add = { name: "add" as const, changes: [{ module: "auth", option: "none" }, { module: "storage", option: "none" }] };
    await expect(completeCommand(manifest, project, add, false)).resolves.toEqual(add);
    await expect(completeCommand(manifest, project, { name: "remove", modules: ["storage"] }, false)).resolves.toEqual({
      name: "remove",
      modules: ["storage"],
    });
    await expect(completeCommand(manifest, project, { name: "add", changes: [{ module: "auth" }] }, false)).rejects.toThrow(
      "Run it in a terminal to choose from a list",
    );
    await expect(completeCommand(manifest, project, { name: "remove", modules: [] }, false)).rejects.toThrow(
      "Usage: remove <module>",
    );
  });
});

describe("changedModules", () => {
  async function setup(modules: Record<string, string>) {
    const starter = await temporaryDirectory();
    await writeFiles(starter, moduleStarterFiles());
    const manifest = await readTemplateManifest(starter);
    const project = { modules } as unknown as Parameters<typeof changedModules>[1];
    return { manifest, project };
  }

  it("applies every change before checking requirements, so related changes can go together", async () => {
    const { manifest, project } = await setup({ auth: "none", storage: "none" });
    const storageOnly = { name: "add" as const, changes: [{ module: "storage", option: "supabase" }] };
    expect(() => changedModules(manifest, project, storageOnly, "pnpm clubedge")).toThrow();

    const both = {
      name: "add" as const,
      changes: [
        { module: "storage", option: "supabase" },
        { module: "auth", option: "supabase" },
      ],
    };
    expect(changedModules(manifest, project, both, "pnpm clubedge")).toEqual({ auth: "supabase", storage: "supabase" });
  });

  it("removes several modules at once and names the first problem", async () => {
    const { manifest, project } = await setup({ auth: "supabase", storage: "s3" });
    expect(changedModules(manifest, project, { name: "remove", modules: ["storage", "auth"] }, "pnpm clubedge")).toEqual({
      auth: "none",
      storage: "none",
    });
    expect(() =>
      changedModules(manifest, project, { name: "add", changes: [{ module: "cache", option: "redis" }] }, "pnpm clubedge"),
    ).toThrow('Unknown module "cache"');
    expect(() =>
      changedModules(manifest, project, { name: "add", changes: [{ module: "auth", option: "magic" }] }, "pnpm clubedge"),
    ).toThrow('Unknown auth option "magic"');
  });
});

describe("incoming versions", () => {
  const plan = (root: string, actions: UpdatePlan["actions"]): UpdatePlan => ({
    project: { root } as UpdatePlan["project"],
    actions,
    lockfile: { kind: "unchanged" },
    envs: [],
  });

  it("saves the Starter's version of each file left to resolve, in a folder Git ignores", async () => {
    const root = await temporaryDirectory();
    await applyUpdate(
      plan(root, [
        { path: "src/a.ts", kind: "conflict", content: Buffer.from("<<<<<<< yours\n"), incoming: Buffer.from("theirs\n") },
        { path: "src/b.ts", kind: "keep", reason: "deleted", incoming: Buffer.from("restored\n") },
        { path: "src/c.ts", kind: "keep", reason: "removed" },
        { path: "src/d.ts", kind: "merge", content: Buffer.from("merged\n") },
      ]),
    );
    expect(await readFile(join(root, INCOMING_DIR, "src/a.ts"), "utf8")).toBe("theirs\n");
    expect(await readFile(join(root, INCOMING_DIR, "src/b.ts"), "utf8")).toBe("restored\n");
    expect(await pathExists(join(root, INCOMING_DIR, "src/c.ts"))).toBe(false);
    expect(await pathExists(join(root, INCOMING_DIR, "src/d.ts"))).toBe(false);
    expect(await readFile(join(root, ".clubedge/.gitignore"), "utf8")).toMatch(/^\*$/m);
  });

  it("replaces the previous change's files and writes nothing without conflicts", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, INCOMING_DIR, "old"), { recursive: true });
    await writeFile(join(root, INCOMING_DIR, "old/stale.ts"), "stale\n");
    const clean = plan(root, [{ path: "src/d.ts", kind: "update", content: Buffer.from("new\n") }]);
    expect(incomingFiles(clean)).toEqual([]);
    await applyUpdate(clean);
    expect(await pathExists(join(root, INCOMING_DIR))).toBe(false);
  });
});
