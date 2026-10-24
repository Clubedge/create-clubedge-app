// `status` and `doctor` look at an existing project without changing it: status reports where
// it stands and what to run next, and doctor checks that it can run.
import { log, outro } from "@clack/prompts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import type { CliArgs } from "./cli/args.js";
import { dim } from "./cli/ui.js";
import {
  checkConflicts,
  checkDatabaseUrls,
  checkEnvFile,
  checkLockfile,
  checkNode,
  checkPnpm,
  fetchLatestRelease,
  nextStep,
  updateState,
  type CheckResult,
  type ConflictedFile,
  type GitState,
} from "./core/health.js";
import { countConflicts } from "./core/merge.js";
import { parseEnvFile } from "./core/deploy.js";
import { neonDatabaseState } from "./core/neon.js";
import { databaseEnvFile, projectEnvFiles, readProject } from "./core/project.js";
import { savedDatabaseForUrl } from "./neon.js";
import { cliCommand } from "./modify.js";
import { resolvePnpm } from "./steps/install.js";
import { listTemplateFiles, pathExists } from "./utils/fs.js";
import { commandSucceeds, run, runCapture } from "./utils/process.js";

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function gitState(root: string): Promise<GitState> {
  if (!(await commandSucceeds("git", ["-C", root, "rev-parse", "--is-inside-work-tree"]))) return { kind: "none" };
  const status = await runCapture("git", ["-C", root, "status", "--porcelain"]);
  const files = status.split("\n").filter(Boolean).length;
  return files ? { kind: "dirty", files } : { kind: "clean" };
}

const describeGit = (git: GitState) =>
  git.kind === "none"
    ? "not a Git repository"
    : git.kind === "clean"
      ? "clean"
      : `${git.files} uncommitted ${git.files === 1 ? "change" : "changes"}`;

export async function showStatus(_args: CliArgs): Promise<void> {
  const project = await readProject(process.cwd());
  const [git, latest, cli] = await Promise.all([gitState(project.root), fetchLatestRelease(), cliCommand(project)]);
  const update = updateState(project.starterRef, latest);

  const commit = project.starterCommit ? ` ${dim(`(commit ${project.starterCommit.slice(0, 7)})`)}` : "";
  const modules = Object.entries(project.modules)
    .map(([id, option]) => `${id}: ${option}`)
    .join(", ");
  const updates =
    update.kind === "available"
      ? `Starter ${update.starterRef} is available (create-clubedge-app ${update.cliVersion})`
      : update.kind === "current"
        ? "on the newest Starter release"
        : "could not check";
  const rows: Array<[string, string]> = [
    ["Project", project.identity.packageName],
    ["Starter", `${project.starterRef}${commit}, created with create-clubedge-app ${project.cliVersion}`],
    ...Object.entries(project.stacks).map(([slot, stack]): [string, string] => [slot[0]!.toUpperCase() + slot.slice(1), stack]),
    ["Modules", modules],
    ["Git", describeGit(git)],
    ["Updates", updates],
  ];
  log.message(rows.map(([label, value]) => `${label.padEnd(10)} ${value}`).join("\n"));
  outro(nextStep(git, update, cli));
}

/** Runs `pnpm install --frozen-lockfile --lockfile-only` offline; resolves its error or null. */
async function lockfileError(root: string, pnpm: string[]): Promise<string | null> {
  const [command, ...prefix] = pnpm;
  try {
    await runCapture(command!, [...prefix, "install", "--frozen-lockfile", "--lockfile-only", "--offline"], root);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function print(result: CheckResult) {
  const line = `${result.name}: ${result.detail}${result.fix ? `\n${dim(result.fix)}` : ""}`;
  if (result.status === "ok") log.success(line);
  else if (result.status === "warn") log.warn(line);
  else log.error(line);
}

export async function findConflictedFiles(root: string): Promise<ConflictedFile[]> {
  const files = await listTemplateFiles(root);
  const conflicts: ConflictedFile[] = [];
  for (const file of files) {
    const content = await readFile(join(root, file)).catch(() => null);
    if (!content) continue;
    const blocks = countConflicts(content);
    if (blocks > 0) conflicts.push({ path: file, blocks });
  }
  return conflicts;
}

export async function runDoctor(args: CliArgs): Promise<void> {
  const project = await readProject(process.cwd());
  const root = project.root;
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    engines?: { node?: string };
    packageManager?: string;
    scripts?: Record<string, string>;
  };
  const results: CheckResult[] = [];
  const check = (result: CheckResult) => {
    results.push(result);
    print(result);
  };

  check(checkNode(process.versions.node, manifest.engines?.node));
  const pnpm = await resolvePnpm();
  const pnpmVersion = pnpm ? await runCapture(pnpm[0]!, [...pnpm.slice(1), "--version"]).catch(() => null) : null;
  check(checkPnpm(pnpmVersion, manifest.packageManager));
  check(checkConflicts(await findConflictedFiles(root)));


  const installed = await pathExists(join(root, "node_modules", ".modules.yaml"));
  check(
    installed
      ? { name: "Dependencies", status: "ok", detail: "installed" }
      : { name: "Dependencies", status: "fail", detail: "not installed", fix: "Run `pnpm install`." },
  );
  if (pnpm) check(checkLockfile(await lockfileError(root, pnpm)));

  // Each app's env file; the database URLs are in the one of the app that owns the database.
  for (const paths of projectEnvFiles(project)) {
    check(checkEnvFile(await readText(join(root, paths.example)), await readText(join(root, paths.local)), paths));
  }

  const envPath = databaseEnvFile(project).local;
  const env = parseEnvFile((await readText(join(root, envPath))) ?? "");
  const saved = await savedDatabaseForUrl(env.DATABASE_URL);
  const database = checkDatabaseUrls({
    env,
    infra: project.modules.infra,
    claimable: saved ? await neonDatabaseState(saved) : null,
    cli: await cliCommand(project),
    envPath,
  });
  if (database) check(database);

  // Service checks need the dependencies, and print their own results.
  if (args.services && manifest.scripts?.["check:services"] && pnpm && installed) {
    log.step("Checking the configured services with `pnpm check:services`");
    try {
      await run(pnpm[0]!, [...pnpm.slice(1), "check:services"], root);
      results.push({ name: "Services", status: "ok", detail: "every configured service answered" });
    } catch {
      check({
        name: "Services",
        status: "fail",
        detail: "a configured service did not answer",
        fix: "See the output above; SETUP.md explains each service.",
      });
    }
  }

  const failed = results.filter((result) => result.status === "fail").length;
  const warned = results.filter((result) => result.status === "warn").length;
  if (failed) process.exitCode = 1;
  outro(
    failed
      ? `${failed} ${failed === 1 ? "check" : "checks"} failed${warned ? ` and ${warned} need attention` : ""}.`
      : warned
        ? `No failures; ${warned} ${warned === 1 ? "check needs" : "checks need"} attention.`
        : "Every check passed.",
  );
}
