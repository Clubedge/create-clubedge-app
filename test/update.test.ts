import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executePlan } from "../src/core/execute.js";
import { readTemplateManifest } from "../src/core/manifest.js";
import { createPlan } from "../src/core/plan.js";
import { readProject } from "../src/core/project.js";
import { readDirectoryTemplate } from "../src/core/source.js";
import { applyUpdate, planUpdate } from "../src/core/update.js";
import { upgradedModules } from "../src/modify.js";
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
      framework: "next",
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
      framework: "next",
      modules: { auth: "supabase", storage: "s3" },
    });
  });

  it("explains when there is no generated project", async () => {
    await expect(readProject(await temporaryDirectory())).rejects.toThrow("No Clubedge project found");
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
    expect(plan.env).toMatchObject({ path: "apps/web/.env.local", update: { removed: ["STORAGE_BUCKET"] } });
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

    expect(plan.env?.update?.added).toEqual(["STORAGE_BUCKET"]);
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
        framework: "next",
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

  it("refuses an option the new Starter no longer offers", async () => {
    const { v2 } = await twoRevisions();
    const manifest = await readTemplateManifest(v2.root);
    const project = { modules: { auth: "magic-link", storage: "s3" } } as unknown as Parameters<typeof upgradedModules>[1];
    expect(() => upgradedModules(manifest, project)).toThrow('no longer offers Authentication "magic-link"');
  });
});
