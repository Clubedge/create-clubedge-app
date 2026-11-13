// The engine, as a program that maintains projects uses it: every change through one call that
// asks nothing, writes nothing to stdout, and resolves the report --json prints.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executePlan } from "../src/core/execute.js";
import { readTemplateManifest } from "../src/core/manifest.js";
import { createPlan } from "../src/core/plan.js";
import { readDirectoryTemplate } from "../src/core/source.js";
import {
  addToProject,
  parseProjectRecord,
  readProjectRecord,
  removeFromProject,
  REPORT_VERSION,
  starter,
  upgradeProject,
  version,
} from "../src/engine.js";
import { cliVersion, starterPin } from "../src/package-info.js";
import { detectPnpm, installDependencies } from "../src/steps/install.js";
import { moduleStarterFiles, temporaryDirectory, writeFiles } from "./helpers.js";

vi.mock("../src/steps/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/steps/install.js")>()),
  detectPnpm: vi.fn(),
  installDependencies: vi.fn(),
}));

/** A project generated from the modules fixture, outside Git, and the Starter it came from. */
async function generatedProject() {
  const starterRoot = await temporaryDirectory();
  await writeFiles(starterRoot, moduleStarterFiles());
  const source = await readDirectoryTemplate(starterRoot);
  const root = join(await temporaryDirectory(), "my-product");
  await executePlan(
    createPlan({
      targetDirectory: root,
      identity: { packageName: "my-product", displayName: "My Product" },
      source,
      manifest: await readTemplateManifest(source.root),
      stacks: { framework: "next" },
      modules: {},
      cliVersion: "1.0.0",
      git: false,
      install: false,
    }),
    source,
  );
  return { root, starterRoot };
}

/** A log that keeps what it is given. */
function memoryLog() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, done) {
      text += String(chunk);
      done();
    },
  });
  return { stream, text: () => text };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(detectPnpm).mockResolvedValue({ pnpm: ["pnpm"] });
  vi.mocked(installDependencies).mockResolvedValue();
  vi.spyOn(process.stdout, "write");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the engine", () => {
  it("names its release and the Starter it upgrades to", () => {
    expect(version).toBe(cliVersion);
    expect(starter).toEqual({ repository: starterPin.starterRepository, ref: starterPin.starterRef, commit: starterPin.starterCommit });
    expect(REPORT_VERSION).toBe(1);
  });

  it("removes a module, updating the lockfile without running anything from the project", async () => {
    const project = await generatedProject();
    const report = await removeFromProject(project.root, ["storage"], { templateDir: project.starterRoot, force: true });

    expect(report).toMatchObject({
      reportVersion: 1,
      cli: cliVersion,
      command: "remove",
      outcome: "changed",
      to: { modules: { storage: "none" } },
      install: { mode: "lockfile-only", status: "done" },
    });
    expect(report.files).toContainEqual({ path: "apps/web/src/server/storage.ts", action: "delete" });
    expect(installDependencies).toHaveBeenCalledWith(
      project.root,
      ["pnpm"],
      ["--lockfile-only", "--ignore-scripts", "--ignore-pnpmfile", "--no-frozen-lockfile"],
      { output: expect.any(Writable) },
    );
    expect(JSON.parse(await readFile(join(project.root, "package.json"), "utf8")).clubedge.modules.storage).toBe("none");
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it("writes its log, as a terminal would show it, where it is asked to", async () => {
    const project = await generatedProject();
    const log = memoryLog();
    await addToProject(project.root, [{ module: "storage", option: "supabase" }], { templateDir: project.starterRoot, force: true, install: "full", log: log.stream });

    expect(log.text()).toContain("File storage: s3 -> supabase");
    expect(log.text()).toContain("Dependencies updated");
    expect(installDependencies).toHaveBeenCalledWith(project.root, ["pnpm"], [], { output: log.stream });
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it("reports what a dry run would do, and installs nothing", async () => {
    const project = await generatedProject();
    const before = await readFile(join(project.root, "package.json"), "utf8");
    const report = await removeFromProject(project.root, ["storage"], { templateDir: project.starterRoot, force: true, dryRun: true });

    expect(report).toMatchObject({ outcome: "changed", dryRun: true, install: { mode: "none", status: "off" } });
    expect(await readFile(join(project.root, "package.json"), "utf8")).toBe(before);
    expect(installDependencies).not.toHaveBeenCalled();
  });

  it("resolves a failed change as a report, and refuses options that contradict each other", async () => {
    const elsewhere = await temporaryDirectory();
    const report = await upgradeProject(elsewhere, { install: "none" });
    expect(report).toMatchObject({ command: "upgrade", outcome: "failed", error: { message: expect.stringContaining("No Clubedge project found here") } });

    const project = await generatedProject();
    // Outside Git, a change needs force, which a person would confirm in a terminal.
    expect(await removeFromProject(project.root, ["storage"], { templateDir: project.starterRoot })).toMatchObject({
      outcome: "failed",
      error: { message: expect.stringContaining("not a Git repository") },
    });
    await expect(upgradeProject(project.root, { ref: "v1.0.0", templateDir: project.starterRoot })).rejects.toThrow("Pass ref or templateDir, not both.");
    await expect(upgradeProject(project.root, { install: "some" as "full" })).rejects.toThrow('Unknown install mode "some"');
    expect(process.stdout.write).not.toHaveBeenCalled();
  });
});

describe("a project's record", () => {
  it("reads the Starter a package.json records, with its apps and modules", () => {
    const record = parseProjectRecord(
      JSON.stringify({
        name: "my-product",
        clubedge: {
          cliVersion: "0.48.2",
          starterRepository: "Clubedge/clubedge-starter",
          starterRef: "v0.31.3",
          starterCommit: "80ba67bb09a468ef49b8ba907e93239e2e04b6c4",
          framework: "vite",
          apps: { api: "hono", shell: "capacitor" },
          modules: { auth: "supabase", payments: "none" },
        },
      }),
    );
    expect(record).toEqual({
      repository: "Clubedge/clubedge-starter",
      ref: "v0.31.3",
      commit: "80ba67bb09a468ef49b8ba907e93239e2e04b6c4",
      cli: "0.48.2",
      stacks: { framework: "vite", api: "hono", shell: "capacitor" },
      modules: { auth: "supabase", payments: "none" },
    });
  });

  it("is null for a package.json that records no Starter, and fills in what old projects left out", () => {
    expect(parseProjectRecord(JSON.stringify({ name: "other" }))).toBeNull();
    expect(parseProjectRecord(JSON.stringify({ clubedge: { starterRef: "" } }))).toBeNull();
    expect(parseProjectRecord(JSON.stringify({ clubedge: { starterRef: "v0.4.0" } }))).toEqual({
      repository: starterPin.starterRepository,
      ref: "v0.4.0",
      stacks: {},
      modules: {},
    });
  });

  it("throws on a package.json with conflict markers, which is not JSON", () => {
    expect(() => parseProjectRecord('{\n<<<<<<< yours\n  "name": "a"\n=======\n  "name": "b"\n>>>>>>> clubedge\n}\n')).toThrow(SyntaxError);
  });

  it("reads the record of the project that holds a folder", async () => {
    const project = await generatedProject();
    expect(await readProjectRecord(join(project.root, "apps", "web"))).toMatchObject({
      root: project.root,
      ref: "local",
      cli: "1.0.0",
      stacks: { framework: "next" },
      modules: { auth: "supabase", storage: "s3" },
    });
  });
});
