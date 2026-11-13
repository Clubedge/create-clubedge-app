// What add and remove do once the files are written: install, the report, and the outcome. pnpm
// and the terminal output are replaced, so nothing is installed and the messages can be read.
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { log, outro } from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "../src/cli/args.js";
import { executePlan } from "../src/core/execute.js";
import { emptyReport } from "../src/core/report.js";
import { readTemplateManifest } from "../src/core/manifest.js";
import { createPlan } from "../src/core/plan.js";
import { downloadGitHubTemplate, readDirectoryTemplate } from "../src/core/source.js";
import { main } from "../src/index.js";
import { changeProject } from "../src/modify.js";
import { starterPin } from "../src/package-info.js";
import { detectPnpm, installDependencies } from "../src/steps/install.js";
import { moduleStarterFiles, starterFiles, temporaryDirectory, writeFiles } from "./helpers.js";

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
  // --force by default: the fixture is not a Git repository.
  const argv = (command: string[], force = true) => [...command, "--template-dir", starter, ...(force ? ["--force"] : []), "--yes"];
  const inProject = () => vi.spyOn(process, "cwd").mockReturnValue(root);
  return {
    root,
    source,
    run: (command: string[], force = true) => (inProject(), changeProject(parseCliArgs(argv(command, force)))),
    main: (command: string[]) => (inProject(), main(argv(command))),
    read: (path: string) => readFile(join(root, path), "utf8"),
    write: (path: string, content: string) => writeFile(join(root, path), content),
  };
}

/**
 * The project's own range for the storage package, the key `remove storage` removes: a conflict
 * even when package.json merges by key.
 */
async function changeStorageDependency(project: Awaited<ReturnType<typeof generatedProject>>) {
  const manifest = await project.read("apps/web/package.json");
  await project.write("apps/web/package.json", manifest.replace('"@clubedge/storage-s3":"workspace:*"', '"@clubedge/storage-s3":"workspace:^"'));
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

  it("counts every file it writes, as its list shows them: the lockfile and env files too", async () => {
    const project = await generatedProject();
    await project.run(["remove", "storage"]);
    const [list] = vi.mocked(log.message).mock.calls.at(-1)!;
    const written = String(list)
      .split("\n")
      .filter((line) => /^(update|add|merge|delete|conflict) /.test(line));
    expect(written).toContainEqual(expect.stringMatching(/^update +pnpm-lock\.yaml$/));
    expect(log.success).toHaveBeenCalledWith(`Updated ${written.length} files`);
  });

  it("merges a dependency the project added next to one the change removes, and installs", async () => {
    const project = await generatedProject();
    const manifest = await project.read("apps/web/package.json");
    await project.write("apps/web/package.json", manifest.replace('"@clubedge/storage-s3":"workspace:*"', '$&,"zod":"^4.2.0"'));

    expect(await project.run(["remove", "storage"])).toBe("changed");

    expect(JSON.parse(await project.read("apps/web/package.json")).dependencies).toEqual({
      "@clubedge/auth-supabase": "workspace:*",
      zod: "^4.2.0",
    });
    expect(installDependencies).toHaveBeenCalledOnce();
    expect(warnings()).toEqual([]);
  });

  it("skips pnpm install when a package.json has conflict markers, and says why", async () => {
    const project = await generatedProject();
    await changeStorageDependency(project);

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
    await changeStorageDependency(project);
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

  it("ends by asking for a typecheck, since files that merged cleanly can still break the code", async () => {
    const project = await generatedProject();
    await project.run(["remove", "storage"]);
    expect(outro).toHaveBeenLastCalledWith(
      "Review the changes with `git diff`, and run `pnpm typecheck` and your tests: files that merged cleanly can still break the code. " +
        "Run `pnpm check:services` and `pnpm db:migrate` if the change added services or tables.",
    );
  });

  it("ends by saying to resolve the conflicts first, and to install when pnpm could not", async () => {
    const project = await generatedProject();
    await changeStorageDependency(project);
    await project.run(["remove", "storage"]);
    expect(outro).toHaveBeenLastCalledWith(
      expect.stringMatching(/^Resolve the conflicts first, then run `pnpm install`\. Then review the changes with `git diff`, and run `pnpm typecheck`/),
    );

    // A conflict outside package.json leaves pnpm working, and the install done.
    const other = await generatedProject();
    await other.write("apps/web/src/server/auth.ts", "export const provider = 'supabase'; // mine\n");
    await other.run(["remove", "auth", "storage"]);
    expect(outro).toHaveBeenLastCalledWith(expect.stringMatching(/^Resolve the conflicts first\. Then review the changes/));
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

// Each test makes a Git repository and commits, and Git is slow to start on Windows.
describe("a project with conflict markers left by an earlier change", { timeout: 20_000 }, () => {
  const marked = "export const provider = 'supabase';\n<<<<<<< yours\nexport const mine = 1;\n=======\nexport const theirs = 1;\n>>>>>>> clubedge\n";

  /** The project with these files written, all committed to Git, as a change expects. */
  async function committed(files: Record<string, string>) {
    const project = await generatedProject();
    for (const [path, content] of Object.entries(files)) await project.write(path, content);
    for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.email=ci@example.com", "-c", "user.name=CI", "commit", "-qm", "Committed"]]) {
      spawnSync("git", args, { cwd: project.root });
    }
    return project;
  }

  it("refuses a change while a file it touches has them, and names the file", async () => {
    const project = await committed({ "apps/web/src/server/auth.ts": marked });
    await expect(project.run(["remove", "auth"], false)).rejects.toThrow(
      /^A file still has conflict markers from an earlier change \(1 block\):\n {2}apps\/web\/src\/server\/auth\.ts \(1 block\)\nThis change would merge into them\./,
    );
    expect(await project.read("apps/web/src/server/auth.ts")).toBe(marked);
  });

  it("refuses it while a file it does not touch has them, as a dry run", async () => {
    const project = await committed({ "notes.md": `# Notes\n${marked}`, "apps/web/plan.md": marked + marked });
    await expect(project.run(["remove", "storage", "--dry-run"], false)).rejects.toThrow(
      "2 files still have conflict markers from an earlier change (3 blocks):\n  apps/web/plan.md (2 blocks)\n  notes.md (1 block)",
    );
  });

  it("goes ahead with --force, and once they are resolved", async () => {
    const project = await committed({ "notes.md": `# Notes\n${marked}` });
    await expect(project.run(["remove", "storage"])).resolves.toBe("changed");
    const resolved = await committed({});
    await expect(resolved.run(["remove", "storage"], false)).resolves.toBe("changed");
  });
});

describe("the exit code of a change", () => {
  it("is 2 for conflicts only with --detailed-exit-code", async () => {
    const project = await generatedProject();
    await changeStorageDependency(project);
    await project.main(["remove", "storage", "--no-install", "--detailed-exit-code"]);
    expect(process.exitCode).toBe(2);
  });

  it("stays 0 for conflicts without it, as the upgrade workflow in existing projects expects", async () => {
    const project = await generatedProject();
    await changeStorageDependency(project);
    await project.main(["remove", "storage", "--no-install"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("is 0 for a clean change with --detailed-exit-code", async () => {
    const project = await generatedProject();
    await project.main(["remove", "storage", "--no-install", "--detailed-exit-code"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("is 2 for a dry run that would leave conflicts, which it counts without writing anything", async () => {
    const project = await generatedProject();
    await changeStorageDependency(project);
    const before = await project.read("apps/web/package.json");

    await project.main(["remove", "storage", "--dry-run", "--detailed-exit-code"]);

    expect(process.exitCode).toBe(2);
    expect(await project.read("apps/web/package.json")).toBe(before);
    expect(warnings()).toEqual([expect.stringMatching(/^The change would leave 1 conflict in 1 file to resolve/)]);
    expect(warnings()[0]).toContain("apps/web/package.json");
  });

  it("is 0 for a dry run without conflicts, and for one with conflicts without --detailed-exit-code", async () => {
    const project = await generatedProject();
    await project.main(["remove", "storage", "--dry-run", "--detailed-exit-code"]);
    expect(process.exitCode).toBeUndefined();
    await changeStorageDependency(project);
    await project.main(["remove", "storage", "--dry-run"]);
    expect(process.exitCode).toBeUndefined();
  });
});

describe("the JSON report of a change", () => {
  /** What the change printed on stdout, which --json keeps for the report alone. */
  const printed = () => vi.mocked(process.stdout.write).mock.calls.map(([chunk]) => String(chunk)).join("");
  const printedReport = () => JSON.parse(printed());

  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("is the only thing on stdout, and the log and pnpm go to stderr", async () => {
    const project = await generatedProject();
    await project.main(["remove", "storage", "--json"]);

    const report = printedReport();
    expect(report).toMatchObject({
      reportVersion: 1,
      command: "remove",
      outcome: "changed",
      dryRun: false,
      summary: "File storage: s3 -> none",
      from: { ref: "local", modules: { auth: "supabase", storage: "s3" } },
      to: { ref: "local", modules: { auth: "supabase", storage: "none" } },
      lockfile: "replace",
      conflicts: { files: 0, blocks: 0 },
      install: { mode: "full", status: "done" },
      releases: [],
      introduced: [],
      warnings: [],
    });
    expect(report.files).toContainEqual({ path: "apps/web/src/server/storage.ts", action: "delete" });
    expect(report.files).toContainEqual({ path: "apps/web/package.json", action: "update" });
    expect(report.next).toMatch(/^Review the changes with `git diff`/);
    expect(process.exitCode).toBeUndefined();

    for (const call of [...vi.mocked(log.message).mock.calls, ...vi.mocked(log.success).mock.calls, ...vi.mocked(outro).mock.calls]) {
      expect(call[1]).toEqual({ output: process.stderr });
    }
    expect(installDependencies).toHaveBeenCalledWith(project.root, ["pnpm"], [], { output: process.stderr });
  });

  it("names each conflict, its blocks, and where the Starter's version is, and skips the install pnpm cannot run", async () => {
    const project = await generatedProject();
    await changeStorageDependency(project);
    await project.main(["remove", "storage", "--json", "--detailed-exit-code"]);

    const report = printedReport();
    expect(report.outcome).toBe("conflicts");
    expect(report.conflicts).toEqual({ files: 1, blocks: 1 });
    expect(report.files).toContainEqual({
      path: "apps/web/package.json",
      action: "conflict",
      conflicts: 1,
      incoming: ".clubedge/incoming/apps/web/package.json",
    });
    expect(report.install).toEqual({ mode: "full", status: "skipped", reason: expect.stringMatching(/^Skipped `pnpm install`: apps\/web\/package\.json has conflict markers/) });
    expect(report.warnings).toEqual([report.install.reason]);
    expect(report.next).toMatch(/^Resolve the conflicts first, then run `pnpm install`\./);
    expect(process.exitCode).toBe(2);
  });

  it("reports what a dry run would do, and writes nothing", async () => {
    const project = await generatedProject();
    await changeStorageDependency(project);
    const before = await project.read("apps/web/package.json");
    await project.main(["remove", "storage", "--json", "--dry-run"]);

    expect(printedReport()).toMatchObject({ outcome: "conflicts", dryRun: true, conflicts: { files: 1, blocks: 1 }, install: { mode: "none", status: "off" } });
    expect(await project.read("apps/web/package.json")).toBe(before);
  });

  it("says what failed, and still lists the files written before the install failed", async () => {
    const project = await generatedProject();
    vi.mocked(installDependencies).mockRejectedValue(new Error("pnpm exited with code 1."));
    await project.main(["remove", "storage", "--json"]);

    const report = printedReport();
    expect(report.outcome).toBe("failed");
    expect(report.error.message).toBe("The files were updated, but `pnpm install` did not complete: pnpm exited with code 1. Fix that, then run `pnpm install`.");
    expect(report.install).toEqual({ mode: "full", status: "failed", reason: "pnpm exited with code 1." });
    expect(report.files).toContainEqual({ path: "apps/web/src/server/storage.ts", action: "delete" });
    expect(process.exitCode).toBe(1);
  });

  it("reports a change refused before it starts, and arguments that do not parse", async () => {
    const project = await generatedProject();
    await project.main(["add", "storage", "dropbox", "--json"]);
    expect(printedReport()).toMatchObject({
      command: "add",
      outcome: "failed",
      from: { modules: { storage: "s3" } },
      files: [],
      error: { message: expect.stringContaining('Unknown storage option "dropbox"') },
    });

    vi.mocked(process.stdout.write).mockClear();
    await main(["upgrade", "--json", "--lockfile-only", "--no-install"]);
    expect(printedReport()).toMatchObject({ command: "upgrade", outcome: "failed", error: { message: "Use either --lockfile-only or --no-install, not both." } });
    expect(process.exitCode).toBe(1);
  });

  it("reports an unchanged project, without asking anything", async () => {
    const project = await generatedProject();
    await project.main(["add", "storage", "s3", "--json"]);
    expect(printedReport()).toMatchObject({ outcome: "unchanged", files: [], notes: ["The project already uses that selection; nothing to change."] });
  });
});

describe("--lockfile-only", () => {
  it("updates the lockfile with pnpm install, running nothing from the project", async () => {
    const project = await generatedProject();
    await project.run(["remove", "storage", "--lockfile-only"]);
    expect(installDependencies).toHaveBeenCalledWith(project.root, ["pnpm"], [
      "--lockfile-only",
      "--ignore-scripts",
      "--ignore-pnpmfile",
      "--no-frozen-lockfile",
    ]);
    expect(log.success).toHaveBeenCalledWith("pnpm-lock.yaml updated, without installing");
  });

  it("names the command that failed", async () => {
    const project = await generatedProject();
    vi.mocked(installDependencies).mockRejectedValue(new Error("pnpm exited with code 1."));
    await expect(project.run(["remove", "storage", "--lockfile-only"])).rejects.toThrow(
      "The files were updated, but `pnpm install --lockfile-only` did not complete: pnpm exited with code 1.",
    );
  });

  it("is skipped like an install while pnpm cannot read a package.json", async () => {
    const project = await generatedProject();
    await changeStorageDependency(project);
    await project.run(["remove", "storage", "--lockfile-only"]);
    expect(installDependencies).not.toHaveBeenCalled();
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


describe("what an upgrade reports", () => {
  const repository = "Clubedge/clubedge-starter";

  /**
   * A project on Starter v1.0.0, the modules fixture, and the upgrade to v2.0.0, which adds a
   * cache module. Both revisions come from the mocked GitHub download.
   */
  async function projectOnV1() {
    const starter = async (ref: string, files: Record<string, string>) => {
      const folder = await temporaryDirectory();
      await writeFiles(folder, files);
      return { ...(await readDirectoryTemplate(folder)), kind: "github" as const, ref, commit: ref.slice(1, 2).repeat(40), repository };
    };
    const files = moduleStarterFiles();
    const manifest = JSON.parse(files["clubedge.template.json"]!);
    const cache = { name: "Cache", default: "redis", options: { redis: { name: "Redis", files: ["apps/web/src/server/cache.ts"] }, none: { name: "None" } } };
    const v1 = await starter("v1.0.0", files);
    const v2 = await starter("v2.0.0", {
      ...files,
      "clubedge.template.json": JSON.stringify({ ...manifest, modules: { ...manifest.modules, cache } }),
      "apps/web/src/server/cache.ts": "export const cache = 'redis';\n",
      "apps/web/src/server/health.ts": "export const healthy = true;\n",
    });
    vi.mocked(downloadGitHubTemplate).mockImplementation(async (ref: string) => (ref === "v2.0.0" ? v2 : v1));

    const root = join(await temporaryDirectory(), "my-product");
    await executePlan(
      createPlan({
        targetDirectory: root,
        identity: { packageName: "my-product", displayName: "My Product" },
        source: v1,
        manifest: await readTemplateManifest(v1.root),
        stacks: { framework: "next" },
        modules: {},
        cliVersion: "1.0.0",
        git: false,
        install: false,
      }),
      v1,
    );
    vi.spyOn(process, "cwd").mockReturnValue(root);
    return {
      root,
      upgrade: (...flags: string[]) => changeProject(parseCliArgs(["upgrade", "--ref", "v2.0.0", "--force", "--yes", "--no-install", ...flags])),
    };
  }

  const infos = () => vi.mocked(log.info).mock.calls.map(([message]) => message);

  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([
        { tag_name: "v2.0.0", name: "v2.0.0", body: "## Cache\n" },
        { tag_name: "v1.0.0", name: "v1.0.0", body: "## First\n" },
      ]),
    );
  });

  it("names the project's Starter as the one without a new module, not the target as the one that added it", async () => {
    const project = await projectOnV1();
    expect(await project.upgrade()).toBe("changed");
    expect(infos()).toContainEqual(
      expect.stringMatching(/^Cache is new since Starter v1\.0\.0; the project uses "none"\. Choose another option with: .+ add cache <option>$/),
    );
    expect(infos().join("\n")).not.toContain("adds Cache");
  });

  it("leaves the CLI's commands until package.json conflicts are resolved, since pnpm cannot run them before", async () => {
    const project = await projectOnV1();
    await writeFile(
      join(project.root, "packages/auth-supabase/package.json"),
      '{\n<<<<<<< yours\n  "name": "auth"\n=======\n  "name": "@clubedge/auth-supabase"\n>>>>>>> clubedge\n}\n',
    );
    await project.upgrade();
    expect(infos()).toContainEqual(
      expect.stringMatching(/the project uses "none"\. Once the package\.json conflicts are resolved, choose another option with: .+ add cache <option>$/),
    );
    expect(outro).toHaveBeenLastCalledWith(expect.stringMatching(/^Resolve the conflicts first, then run `pnpm install`\./));
  });

  it("lists the Starter releases the upgrade crosses", async () => {
    const project = await projectOnV1();
    await project.upgrade();
    expect(infos()).toContain("Starter releases in this upgrade:\nv2.0.0  Cache");
  });

  it("reports the releases it crosses, the modules it introduces, and both Starters", async () => {
    const project = await projectOnV1();
    const report = emptyReport("upgrade", "test", false);
    vi.mocked(process.cwd).mockReturnValue(project.root);
    await changeProject(parseCliArgs(["upgrade", "--ref", "v2.0.0", "--force", "--json", "--no-install"]), { report, output: process.stderr });

    expect(report).toMatchObject({
      outcome: "changed",
      summary: "Starter v1.0.0 -> v2.0.0",
      from: { repository, ref: "v1.0.0", commit: "1".repeat(40) },
      to: { repository, ref: "v2.0.0", commit: "2".repeat(40), modules: { cache: "none" } },
      releases: [{ tag: "v2.0.0", name: "v2.0.0", url: `https://github.com/${repository}/releases/tag/v2.0.0`, headings: ["Cache"] }],
      introduced: [{ module: "cache", option: "none" }],
      install: { mode: "none", status: "off" },
    });
    expect(report.files).toContainEqual({ path: "apps/web/src/server/health.ts", action: "add" });
    expect(report.notes).toContainEqual(expect.stringMatching(/^Cache is new since Starter v1\.0\.0/));
    expect(report.notes).toContain(`Release notes: https://github.com/${repository}/releases/tag/v2.0.0`);
  });

  it("reports the releases as unknown when GitHub could not list them", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("API rate limit exceeded", { status: 403 }));
    const project = await projectOnV1();
    const report = emptyReport("upgrade", "test", false);
    await changeProject(parseCliArgs(["upgrade", "--ref", "v2.0.0", "--force", "--json", "--no-install"]), { root: project.root, report });
    expect(report.releases).toBeNull();
  });

  it("says when GitHub could not list the releases, as past its rate limit, instead of leaving them out", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("API rate limit exceeded", { status: 403 }));
    const project = await projectOnV1();
    await project.upgrade();
    expect(infos()).toContainEqual(
      expect.stringMatching(/^Could not list the Starter releases in this upgrade: .*rate limit.* https:\/\/github\.com\/Clubedge\/clubedge-starter\/releases\.$/),
    );
  });
});

describe("a project from a Starter without modules", () => {
  const repository = "Clubedge/clubedge-starter";

  /**
   * A project on Starter v0.4.0, a schema 1 Starter with neither modules nor a choice of
   * framework, as before v0.5.0, which records none in package.json; v1.0.0 has modules.
   */
  async function projectOnV04() {
    const starter = async (ref: string, files: Record<string, string>) => {
      const folder = await temporaryDirectory();
      await writeFiles(folder, files);
      return { ...(await readDirectoryTemplate(folder)), kind: "github" as const, ref, commit: ref.slice(1, 2).repeat(40), repository };
    };
    const v04 = await starter("v0.4.0", starterFiles());
    const v1 = await starter("v1.0.0", moduleStarterFiles());
    // Fetched by tag for the upgrade, and by commit for the project's own Starter.
    vi.mocked(downloadGitHubTemplate).mockImplementation(async (ref: string) => ([v1.ref, v1.commit].includes(ref) ? v1 : v04));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([]));

    const root = join(await temporaryDirectory(), "my-product");
    await executePlan(
      createPlan({
        targetDirectory: root,
        identity: { packageName: "my-product", displayName: "My Product" },
        source: v04,
        manifest: await readTemplateManifest(v04.root),
        stacks: {},
        modules: {},
        cliVersion: "0.48.0",
        git: false,
        install: false,
      }),
      v04,
    );
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const read = async () => JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    return {
      root,
      read,
      change: (...command: string[]) => changeProject(parseCliArgs([...command, "--force", "--yes", "--no-install"])),
    };
  }

  it("records no modules when it is generated", async () => {
    const project = await projectOnV04();
    expect((await project.read()).clubedge).not.toHaveProperty("modules");
  });

  it("upgrades to a Starter with modules, keeping what the old one built in", async () => {
    const project = await projectOnV04();
    expect(await project.change("upgrade", "--ref", "v1.0.0")).toBe("changed");
    const { clubedge } = await project.read();
    // Supabase Auth and S3 storage, which Starters before v0.5.0 built in, not "none".
    expect(clubedge).toMatchObject({ starterRef: "v1.0.0", modules: { auth: "supabase", storage: "s3" } });
    expect(vi.mocked(log.info).mock.calls.map(([message]) => message)).toContainEqual(
      expect.stringMatching(/^Starter v0\.4\.0 had no modules yet, but built in what became the first ones, so the project keeps them: Authentication: .+, File storage: .+\. Switch one with: .+ add <module> <option>$/),
    );
  });

  it("says to upgrade first when add or remove has nothing to change", async () => {
    const project = await projectOnV04();
    await expect(project.change("add", "cache", "memory")).rejects.toThrow(
      /^Starter v0\.4\.0, which this project comes from, has no modules or apps to add: they came in later releases\. Upgrade the project first with `.+ upgrade`, then add them\.$/,
    );
    await expect(project.change("remove", "storage")).rejects.toThrow(/has no modules or apps to remove/);
  });

  it("refuses a project whose package.json lost the modules its Starter has, and names them", async () => {
    const project = await projectOnV04();
    await project.change("upgrade", "--ref", "v1.0.0");
    const manifest = await project.read();
    delete manifest.clubedge.modules;
    await writeFile(join(project.root, "package.json"), JSON.stringify(manifest, null, 2));
    await expect(project.change("add", "auth", "none")).rejects.toThrow(
      /^package\.json does not record this project's modules, which Starter v1\.0\.0 has, .+ one entry for each of auth, storage/,
    );
  });
});

describe("an upgrade that moves a patched dependency", () => {
  const repository = "Clubedge/clubedge-starter";

  /** A project on v1.0.0 with a patch on zod 4.6.5, whose web app asks for zod `v1` then `v2`. */
  async function patchedProject(v1Zod: string, v2Zod: string) {
    const starter = async (ref: string, zod: string) => {
      const folder = await temporaryDirectory();
      const files = moduleStarterFiles();
      const web = JSON.parse(files["apps/web/package.json"]!);
      await writeFiles(folder, { ...files, "apps/web/package.json": JSON.stringify({ ...web, dependencies: { ...web.dependencies, zod } }) });
      return { ...(await readDirectoryTemplate(folder)), kind: "github" as const, ref, commit: ref.slice(1, 2).repeat(40), repository };
    };
    const v1 = await starter("v1.0.0", v1Zod);
    const v2 = await starter("v2.0.0", v2Zod);
    vi.mocked(downloadGitHubTemplate).mockImplementation(async (ref: string) => ([v2.ref, v2.commit].includes(ref) ? v2 : v1));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([]));
    const root = join(await temporaryDirectory(), "my-product");
    await executePlan(
      createPlan({
        targetDirectory: root,
        identity: { packageName: "my-product", displayName: "My Product" },
        source: v1,
        manifest: await readTemplateManifest(v1.root),
        stacks: { framework: "next" },
        modules: {},
        cliVersion: "1.0.0",
        git: false,
        install: false,
      }),
      v1,
    );
    // What `pnpm patch zod@4.6.5` and `pnpm patch-commit` leave in a project with a pnpm field.
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    manifest.pnpm = { ...manifest.pnpm, patchedDependencies: { "zod@4.6.5": "patches/zod@4.6.5.patch" } };
    await writeFiles(root, { "package.json": JSON.stringify(manifest, null, 2), "patches/zod@4.6.5.patch": "diff\n" });
    vi.spyOn(process, "cwd").mockReturnValue(root);
    return { upgrade: () => changeProject(parseCliArgs(["upgrade", "--ref", "v2.0.0", "--force", "--yes"])) };
  }

  it("names the patch pnpm would not use, and leaves the install until it is fixed", async () => {
    const project = await patchedProject("^4.6.0", "^4.6.7");
    expect(await project.upgrade()).toBe("changed");
    expect(installDependencies).not.toHaveBeenCalled();
    expect(warnings()).toContainEqual(
      expect.stringMatching(
        /^Skipped `pnpm install`: it would stop on a patch .+\n {2}zod@4\.6\.5 \(patches\/zod@4\.6\.5\.patch, in package\.json\): the project now asks for zod \^4\.6\.7\nTo try it on the new version, key it by the package alone in package\.json/,
      ),
    );
  });

  it("installs as usual when the project's range still allows the patched version", async () => {
    const project = await patchedProject("^4.6.0", "^4.6.2");
    await project.upgrade();
    expect(installDependencies).toHaveBeenCalled();
    expect(warnings().join("\n")).not.toContain("ERR_PNPM_UNUSED_PATCH");
  });
});
