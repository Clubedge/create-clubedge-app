// What add and remove do once the files are written: install, the report, and the outcome. pnpm
// and the terminal output are replaced, so nothing is installed and the messages can be read.
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { log } from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "../src/cli/args.js";
import { executePlan } from "../src/core/execute.js";
import { readTemplateManifest } from "../src/core/manifest.js";
import { createPlan } from "../src/core/plan.js";
import { downloadGitHubTemplate, readDirectoryTemplate } from "../src/core/source.js";
import { main } from "../src/index.js";
import { changeProject } from "../src/modify.js";
import { starterPin } from "../src/package-info.js";
import { detectPnpm, installDependencies } from "../src/steps/install.js";
import { moduleStarterFiles, temporaryDirectory, writeFiles } from "./helpers.js";

vi.mock("../src/steps/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/steps/install.js")>()),
  detectPnpm: vi.fn(),
  installDependencies: vi.fn(),
}));

vi.mock("../src/core/source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/source.js")>();
  return {
    ...actual,
    downloadGitHubTemplate: vi.fn(),
    resolveTemplateSource: vi.fn(async ({ ref, templateDir }: { ref?: string; templateDir?: string } = {}) => {
      if (templateDir) return actual.readDirectoryTemplate(templateDir);
      return vi.mocked(downloadGitHubTemplate)(ref ?? starterPin.starterRef);
    }),
  };
});

const spinnerStart = vi.fn();

vi.mock("@clack/prompts", async (importOriginal) => {
  const prompts = await importOriginal<typeof import("@clack/prompts")>();
  return {
    ...prompts,
    intro: vi.fn(),
    outro: vi.fn(),
    spinner: () => ({ start: spinnerStart, stop: vi.fn(), message: vi.fn() }),
    log: { info: vi.fn(), warn: vi.fn(), success: vi.fn(), message: vi.fn(), error: vi.fn(), step: vi.fn() },
  };
});

/** A project generated from the modules fixture, and a function that runs a command in it. */
async function generatedProject() {
  const starter = await temporaryDirectory();
  await writeFiles(starter, moduleStarterFiles());
  const source = await readDirectoryTemplate(starter);
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
  const argv = (command: string[]) => [...command, "--template-dir", starter, "--force", "--yes"];
  const inProject = () => vi.spyOn(process, "cwd").mockReturnValue(root);
  return {
    root,
    source,
    run: (command: string[]) => (inProject(), changeProject(parseCliArgs(argv(command)))),
    main: (command: string[]) => (inProject(), main(argv(command))),
    read: (path: string) => readFile(join(root, path), "utf8"),
    write: (path: string, content: string) => writeFile(join(root, path), content),
  };
}

/** The project's own dependency, on the line `remove storage` rewrites. */
async function addOwnDependency(project: Awaited<ReturnType<typeof generatedProject>>) {
  const manifest = await project.read("apps/web/package.json");
  await project.write("apps/web/package.json", manifest.replace('"@clubedge/storage-s3":"workspace:*"', '$&,"zod":"^4.2.0"'));
}

const warnings = () => vi.mocked(log.warn).mock.calls.map(([message]) => message);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(detectPnpm).mockResolvedValue({ pnpm: ["pnpm"] });
  vi.mocked(installDependencies).mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("changeProject after the files are written", () => {
  it("installs and reports a clean change", async () => {
    const project = await generatedProject();
    expect(await project.run(["remove", "storage"])).toBe("changed");
    expect(installDependencies).toHaveBeenCalledOnce();
    expect(warnings()).toEqual([]);
  });

  it("skips pnpm install when a package.json has conflict markers, and says why", async () => {
    const project = await generatedProject();
    await addOwnDependency(project);

    expect(await project.run(["remove", "storage"])).toBe("conflicts");

    expect(await project.read("apps/web/package.json")).toContain("<<<<<<< yours");
    expect(detectPnpm).not.toHaveBeenCalled();
    expect(installDependencies).not.toHaveBeenCalled();
    expect(warnings()).toEqual([
      "Skipped `pnpm install`: apps/web/package.json has conflict markers, which pnpm cannot read, so pnpm commands, `pnpm clubedge` among them, fail until it is resolved. Then run `pnpm install`.",
      expect.stringContaining("Resolve 1 conflict in 1 file."),
    ]);
    expect(warnings()[1]).toContain("git diff --no-index apps/web/package.json .clubedge/incoming/apps/web/package.json");
  });

  it("skips pnpm install for a package.json an earlier change left conflicted, which this one does not touch", async () => {
    const project = await generatedProject();
    await project.write(
      "packages/auth-supabase/package.json",
      '{\n<<<<<<< yours\n  "name": "auth"\n=======\n  "name": "@clubedge/auth-supabase"\n>>>>>>> clubedge\n}\n',
    );

    expect(await project.run(["remove", "storage"])).toBe("changed");

    expect(installDependencies).not.toHaveBeenCalled();
    expect(warnings()).toEqual([
      expect.stringMatching(/^Skipped `pnpm install`: packages\/auth-supabase\/package\.json has conflict markers/),
    ]);
  });

  it("says why pnpm commands fail with --no-install too", async () => {
    const project = await generatedProject();
    await addOwnDependency(project);
    await project.run(["remove", "storage", "--no-install"]);
    expect(warnings()[0]).toMatch(/^apps\/web\/package\.json has conflict markers, which pnpm cannot read/);
  });

  it("prints what is left to resolve before failing when pnpm install fails", async () => {
    const project = await generatedProject();
    await project.write("apps/web/src/server/auth.ts", "export const provider = 'supabase'; // mine\n");
    vi.mocked(installDependencies).mockRejectedValue(new Error("pnpm exited with code 1."));

    await expect(project.run(["remove", "auth", "storage"])).rejects.toThrow(
      "The files were updated, but `pnpm install` did not complete: pnpm exited with code 1. Fix that, then run `pnpm install`.",
    );
    expect(warnings()).toEqual([expect.stringContaining("Resolve 1 conflict in 1 file.")]);
    expect(warnings()[0]).toContain("apps/web/src/server/auth.ts");
  });

  it("reports a pnpm that is installed but did not run, instead of a missing one", async () => {
    const project = await generatedProject();
    vi.mocked(detectPnpm).mockResolvedValue({ pnpm: null, problem: "`pnpm --version` failed: boom." });
    await project.run(["remove", "storage"]);
    expect(warnings()).toEqual([
      "pnpm is installed but did not run, so dependencies were not updated. `pnpm --version` failed: boom. Run `pnpm install` once it works.",
    ]);
  });
});

describe("the exit code of a change", () => {
  it("is 2 for conflicts only with --detailed-exit-code", async () => {
    const project = await generatedProject();
    await addOwnDependency(project);
    await project.main(["remove", "storage", "--no-install", "--detailed-exit-code"]);
    expect(process.exitCode).toBe(2);
  });

  it("stays 0 for conflicts without it, as the upgrade workflow in existing projects expects", async () => {
    const project = await generatedProject();
    await addOwnDependency(project);
    await project.main(["remove", "storage", "--no-install"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("is 0 for a clean change with --detailed-exit-code", async () => {
    const project = await generatedProject();
    await project.main(["remove", "storage", "--no-install", "--detailed-exit-code"]);
    expect(process.exitCode).toBeUndefined();
  });
});

describe("early exit on no-op changes", () => {
  it("exits early without preparing templates when adding an already-configured module option", async () => {
    const project = await generatedProject();
    expect(await project.run(["add", "auth", "supabase"])).toBe("unchanged");
    expect(spinnerStart).not.toHaveBeenCalled();
  });

  it("exits early without preparing templates when removing an already absent module", async () => {
    const project = await generatedProject();
    const pkg = JSON.parse(await project.read("package.json"));
    pkg.clubedge.modules.storage = "none";
    await project.write("package.json", JSON.stringify(pkg, null, 2) + "\n");

    expect(await project.run(["remove", "storage"])).toBe("unchanged");
    expect(spinnerStart).not.toHaveBeenCalled();
  });

  it("fails with an unknown-module error when removing an unknown module id", async () => {
    const project = await generatedProject();
    await expect(project.run(["remove", "authh"])).rejects.toThrow('Unknown module "authh"');
  });

  it("exits early without preparing templates when upgrading a project already on the target commit", async () => {
    const project = await generatedProject();
    const pkg = JSON.parse(await project.read("package.json"));
    pkg.clubedge.starterCommit = starterPin.starterCommit;
    await project.write("package.json", JSON.stringify(pkg, null, 2) + "\n");

    vi.spyOn(process, "cwd").mockReturnValue(project.root);
    const outcomeWithoutRef = await changeProject(parseCliArgs(["upgrade", "--force", "--yes"]));
    expect(outcomeWithoutRef).toBe("unchanged");
    expect(spinnerStart).not.toHaveBeenCalled();

    const outcomeWithCommit = await changeProject(
      parseCliArgs(["upgrade", "--ref", starterPin.starterCommit, "--force", "--yes"]),
    );
    expect(outcomeWithCommit).toBe("unchanged");
    expect(spinnerStart).not.toHaveBeenCalled();
  });

  it("still prepares both revisions when upgrade is passed a branch --ref equal to the recorded ref", async () => {
    const project = await generatedProject();
    const pkg = JSON.parse(await project.read("package.json"));
    pkg.clubedge.starterCommit = "1".repeat(40);
    pkg.clubedge.starterRef = "main";
    await project.write("package.json", JSON.stringify(pkg, null, 2) + "\n");

    vi.mocked(downloadGitHubTemplate).mockResolvedValue({
      ...project.source,
      kind: "github",
      commit: "1".repeat(40),
      ref: "main",
      repository: "Clubedge/starter",
    });
    vi.spyOn(process, "cwd").mockReturnValue(project.root);

    const outcome = await changeProject(parseCliArgs(["upgrade", "--ref", "main", "--force", "--yes"]));
    expect(outcome).toBe("unchanged");
    expect(spinnerStart).toHaveBeenCalledWith("Preparing both Starter revisions");
    expect(downloadGitHubTemplate).toHaveBeenCalledWith("main");
  });

  it("succeeds on a no-op command with uncommitted changes", async () => {
    const project = await generatedProject();
    spawnSync("git", ["init", "-q"], { cwd: project.root });
    spawnSync("git", ["config", "user.email", "ci@example.com"], { cwd: project.root });
    spawnSync("git", ["config", "user.name", "CI"], { cwd: project.root });
    spawnSync("git", ["add", "-A"], { cwd: project.root });
    spawnSync("git", ["commit", "-qm", "Initial commit"], { cwd: project.root });

    await project.write("dirty.txt", "uncommitted changes");

    vi.spyOn(process, "cwd").mockReturnValue(project.root);
    const outcome = await changeProject(parseCliArgs(["add", "auth", "supabase", "--yes"]));
    expect(outcome).toBe("unchanged");
    expect(spinnerStart).not.toHaveBeenCalled();
  });
});

