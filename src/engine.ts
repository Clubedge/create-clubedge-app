// The CLI's upgrade engine as a library, for programs that maintain projects, such as a service
// that opens upgrade pull requests:
//
//   import { upgradeProject } from "@clubedge/create-clubedge-app";
//   const report = await upgradeProject("/path/to/project");
//
// Each call changes one project on disk exactly as `add`, `remove`, or `upgrade` does, asks
// nothing, and resolves the report those commands print with --json (see core/report.ts),
// failures included. It never writes to stdout: the log goes to `log`, or nowhere.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { parseCliArgs, type CliArgs } from "./cli/args.js";
import { recordedStacks } from "./core/customize.js";
import { readProject } from "./core/project.js";
import { emptyReport, REPORT_VERSION, type ChangeReport } from "./core/report.js";
import { changeProject } from "./modify.js";
import { cliVersion, starterPin } from "./package-info.js";

export { REPORT_VERSION };
export type {
  ChangeCommandName,
  ChangeReport,
  EnvFileReport,
  FileReport,
  InstallReport,
  ProjectState,
  ReleaseReport,
} from "./core/report.js";

/** This release of the engine, which is the CLI's. */
export const version: string = cliVersion;

/** The Starter release an upgrade moves a project to when no `ref` is given. */
export const starter: { repository: string; ref: string; commit: string } = {
  repository: starterPin.starterRepository,
  ref: starterPin.starterRef,
  commit: starterPin.starterCommit,
};

export interface ChangeOptions {
  /**
   * How the change's dependencies are installed:
   * - "lockfile-only", the default: pnpm-lock.yaml follows the change, and nothing from the
   *   project runs (`pnpm install --lockfile-only --ignore-scripts --ignore-pnpmfile`);
   * - "full": `pnpm install`, which runs the project's install scripts;
   * - "none": nothing, for `pnpm install` later.
   */
  install?: "lockfile-only" | "full" | "none";
  /** Report what the change would do, and write nothing. */
  dryRun?: boolean;
  /** Change a project with uncommitted changes, unresolved conflict markers, or no Git. */
  force?: boolean;
  /** Where the log goes, as a terminal would show it, with pnpm's output; nowhere when unset. */
  log?: Writable;
  /** upgrade: the Starter tag, branch, or commit to move to; `starter.ref` when unset. */
  ref?: string;
  /**
   * A Starter checkout to use instead of GitHub: the Starter an upgrade moves to, or for add and
   * remove, the project's own.
   */
  templateDir?: string;
}

/** A log that goes nowhere. */
const nowhere = () => new Writable({ write: (_chunk, _encoding, done) => done() });

async function change(root: string, command: Extract<CliArgs["command"], { name: "add" | "remove" | "upgrade" }>, options: ChangeOptions) {
  if (options.ref !== undefined && options.templateDir !== undefined) throw new TypeError("Pass ref or templateDir, not both.");
  const install = options.install ?? "lockfile-only";
  if (!["lockfile-only", "full", "none"].includes(install)) throw new TypeError(`Unknown install mode "${install}": use lockfile-only, full, or none.`);
  const args: CliArgs = {
    ...parseCliArgs([]),
    command,
    ref: options.ref,
    templateDir: options.templateDir,
    install: install !== "none",
    lockfileOnly: install === "lockfile-only",
    dryRun: options.dryRun ?? false,
    force: options.force ?? false,
    yes: true,
    json: true,
  };
  const report = emptyReport(command.name, cliVersion, args.dryRun);
  try {
    await changeProject(args, { root, output: options.log ?? nowhere(), report });
  } catch (error) {
    report.outcome = "failed";
    report.error = { message: error instanceof Error ? error.message : String(error) };
  }
  return report;
}

/** Upgrades the project in `root` to a newer Starter: `starter.ref`, or `options.ref`. */
export function upgradeProject(root: string, options: ChangeOptions = {}): Promise<ChangeReport> {
  return change(root, { name: "upgrade" }, options);
}

/**
 * Adds or switches modules and apps in one change, such as
 * `[{ module: "payments", option: "stripe" }]` or `[{ module: "mobile", option: "expo" }]`.
 */
export function addToProject(root: string, changes: Array<{ module: string; option: string }>, options: ChangeOptions = {}): Promise<ChangeReport> {
  return change(root, { name: "add", changes: changes.map(({ module, option }) => ({ module, option })) }, options);
}

/** Removes modules (their option becomes none) and apps installed on devices, in one change. */
export function removeFromProject(root: string, modules: string[], options: ChangeOptions = {}): Promise<ChangeReport> {
  return change(root, { name: "remove", modules: [...modules] }, options);
}

/** What a project's package.json records about the Starter it came from. */
export interface ProjectRecord {
  /** The Starter's GitHub repository, such as Clubedge/clubedge-starter. */
  repository: string;
  /** The Starter release the project is on, such as v0.31.3. */
  ref: string;
  /** Missing for a project made from a local Starter folder outside Git. */
  commit?: string;
  /** The CLI release that last created or changed the project. */
  cli?: string;
  /** The stack per slot, such as { framework: "next", api: "hono" }. */
  stacks: Record<string, string>;
  /** The option per module, such as { auth: "supabase" }; none before Starter v0.5.0. */
  modules: Record<string, string>;
}

/**
 * The record in a package.json's text, as a service reads it from a repository it has not
 * cloned; null when the package.json records no Starter. Throws when the text is not JSON, as
 * while it has conflict markers.
 */
export function parseProjectRecord(packageJson: string): ProjectRecord | null {
  const manifest: unknown = JSON.parse(packageJson);
  const origin = manifest && typeof manifest === "object" ? (manifest as { clubedge?: unknown }).clubedge : undefined;
  if (!origin || typeof origin !== "object") return null;
  const record = origin as Record<string, unknown>;
  if (typeof record.starterRef !== "string" || !record.starterRef) return null;
  return {
    repository: typeof record.starterRepository === "string" ? record.starterRepository : starterPin.starterRepository,
    ref: record.starterRef,
    ...(typeof record.starterCommit === "string" ? { commit: record.starterCommit } : {}),
    ...(typeof record.cliVersion === "string" ? { cli: record.cliVersion } : {}),
    stacks: recordedStacks(record),
    modules: record.modules && typeof record.modules === "object" ? { ...(record.modules as Record<string, string>) } : {},
  };
}

/** The record of the project that contains `directory`, and the project's root folder. */
export async function readProjectRecord(directory: string): Promise<ProjectRecord & { root: string }> {
  const { root } = await readProject(directory);
  return { root, ...parseProjectRecord(await readFile(join(root, "package.json"), "utf8"))! };
}
