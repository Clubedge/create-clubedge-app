// The report of a change, which add, remove, and upgrade print with --json and the engine returns
// (see engine.ts): what the change did to the project, or would do with --dry-run, in a form a
// tool can read instead of the terminal output.
//
// The format is versioned by `reportVersion`. Within a version, fields are only ever added, so a
// reader ignores the ones it does not know; a change to what a field means takes a new version.
import { countConflicts, INCOMING_DIR, type MergeAction } from "./merge.js";
import { releaseHeadings, type Release } from "./releases.js";
import type { UpdatePlan } from "./update.js";

export const REPORT_VERSION = 1;

export type ChangeCommandName = "add" | "remove" | "upgrade";

/** A file the change writes, deletes, or leaves for you to check, as the CLI's list shows it. */
export interface FileReport {
  /** Relative to the project, with forward slashes. */
  path: string;
  /**
   * - add: a new file from the Starter.
   * - update: takes the Starter's new version; the project never changed it.
   * - merge: the project's edits and the Starter's, merged without conflicts.
   * - conflict: written with conflict markers where both changed the same lines.
   * - delete: the Starter no longer has it, and the project never changed it.
   * - keep: left as it is, for you to check (`reason`).
   */
  action: "add" | "update" | "merge" | "conflict" | "delete" | "keep";
  /** conflict: how many blocks are marked `<<<<<<< yours` ... `>>>>>>> clubedge`. */
  conflicts?: number;
  /** keep: why the file is left as it is, and what to check. */
  reason?: string;
  /** conflict and keep: where the Starter's whole new version is saved, to compare with yours. */
  incoming?: string;
}

/** An app's local env file, such as apps/web/.env.local, which Git ignores. */
export interface EnvFileReport {
  path: string;
  /**
   * - create: written from its example, for an app the change adds.
   * - update: variables added, updated, or removed to follow the example.
   * - unchanged: nothing to change.
   * - missing: the file does not exist, so nothing was written; create it from the example.
   */
  action: "create" | "update" | "unchanged" | "missing";
  /** Variables the new example introduces. */
  added: string[];
  /** Variables still at the old example's value, set to the new one. */
  updated: string[];
  /** Variables still at the old example's value that the project no longer uses. */
  removed: string[];
  /** Variables you set yourself whose example value changed: check that yours still fit. */
  customized: string[];
  /** Variables you set that the project no longer uses, left for you to remove. */
  unused: string[];
}

/** How the change's dependencies were installed. */
export interface InstallReport {
  /**
   * - full: `pnpm install`.
   * - lockfile-only: `pnpm install --lockfile-only --ignore-scripts --ignore-pnpmfile`, which
   *   writes pnpm-lock.yaml and runs nothing from the project.
   * - none: --no-install.
   */
  mode: "full" | "lockfile-only" | "none";
  /**
   * - done: the install ran and succeeded.
   * - failed: it ran and failed (`reason`).
   * - skipped: it could not run (`reason`): a package.json with conflict markers, which pnpm
   *   cannot read, a patch pnpm would not use, or no pnpm.
   * - off: nothing was installed: --no-install, a dry run, or nothing to change.
   */
  status: "done" | "failed" | "skipped" | "off";
  reason?: string;
}

/** A Starter release the upgrade crosses. */
export interface ReleaseReport {
  tag: string;
  name: string;
  url: string;
  /** What its notes cover: their second-level headings, such as "Background jobs". */
  headings: string[];
}

/** A project's Starter and selection, as its package.json records them. */
export interface ProjectState {
  /** The Starter's GitHub repository, such as Clubedge/clubedge-starter. */
  repository: string;
  /** The Starter release, branch, or commit, such as v0.32.0. */
  ref: string;
  /** Missing for a project made from a local Starter folder outside Git. */
  commit?: string;
  /** The stack per slot, such as { framework: "next" }. */
  stacks: Record<string, string>;
  /** The option per module, such as { auth: "supabase" }. */
  modules: Record<string, string>;
}

export interface ChangeReport {
  reportVersion: typeof REPORT_VERSION;
  /** The version of the CLI that made the change. */
  cli: string;
  command: ChangeCommandName;
  /**
   * - unchanged: the project already has what was asked.
   * - changed: files were written, without conflicts.
   * - conflicts: files were written, some with conflict markers to resolve (`conflicts`).
   * - failed: see `error`. Files may have been written: `files` lists them when they were, as
   *   when the install failed after the change.
   * With `dryRun`, the outcome the change would have; nothing is written.
   */
  outcome: "unchanged" | "changed" | "conflicts" | "failed";
  dryRun: boolean;
  /** The change in one line, such as "Starter v0.31.3 -> v0.32.0" or "Payments: none -> stripe". */
  summary?: string;
  /** The project before the change. */
  from?: ProjectState;
  /** The project after the change. */
  to?: ProjectState;
  /** Every file the change writes, deletes, or leaves for you, sorted by path. */
  files: FileReport[];
  /**
   * - unchanged: the Starter's lockfile did not change.
   * - replace: the project's lockfile was still the generated one, and takes the new Starter's.
   * - install: the project changed its dependencies, so pnpm reconciles them (see `install`).
   */
  lockfile: "unchanged" | "replace" | "install";
  envFiles: EnvFileReport[];
  /** Totals of the files written with conflict markers. */
  conflicts: { files: number; blocks: number };
  install: InstallReport;
  /** upgrade: the Starter releases it crosses, oldest first; null when GitHub could not list them. */
  releases: ReleaseReport[] | null;
  /** upgrade: modules the new Starter has and the project did not, with the option it now records. */
  introduced: Array<{ module: string; option: string }>;
  /**
   * What needs attention before the change is done: choices below Stable, package.json files
   * pnpm cannot read until their conflicts are resolved, patches pnpm would not use.
   */
  warnings: string[];
  /** Everything else the CLI says about the change, such as deprecations and the release notes. */
  notes: string[];
  /** What to do next, as the CLI's last line says it. */
  next?: string;
  error?: { message: string };
}

/**
 * A report before anything is known, which the change fills in as it goes. The fields it learns
 * later are declared here, unset, so the JSON keeps them in reading order.
 */
export function emptyReport(command: ChangeCommandName, cli: string, dryRun: boolean): ChangeReport {
  return {
    reportVersion: REPORT_VERSION,
    cli,
    command,
    outcome: "unchanged",
    dryRun,
    summary: undefined,
    from: undefined,
    to: undefined,
    files: [],
    lockfile: "unchanged",
    envFiles: [],
    conflicts: { files: 0, blocks: 0 },
    install: { mode: "none", status: "off" },
    releases: [],
    introduced: [],
    warnings: [],
    notes: [],
  };
}

const fileActions: Record<MergeAction["kind"], FileReport["action"]> = {
  create: "add",
  update: "update",
  merge: "merge",
  conflict: "conflict",
  delete: "delete",
  keep: "keep",
};

/** The files a plan writes, deletes, or leaves, as the report lists them. */
export function fileReports(plan: Pick<UpdatePlan, "actions">): FileReport[] {
  return plan.actions.map((action) => ({
    path: action.path,
    action: fileActions[action.kind],
    ...(action.kind === "conflict" ? { conflicts: countConflicts(action.content) } : {}),
    ...(action.kind === "keep" ? { reason: action.reason } : {}),
    ...((action.kind === "conflict" || action.kind === "keep") && action.incoming ? { incoming: `${INCOMING_DIR}/${action.path}` } : {}),
  }));
}

/** The env files a plan updates or creates. */
export function envFileReports(plan: Pick<UpdatePlan, "envs">): EnvFileReport[] {
  return plan.envs.map(({ path, update, changed, create }) => ({
    path,
    action: create ? "create" : !update ? "missing" : changed ? "update" : "unchanged",
    added: update?.added ?? [],
    updated: update?.updated ?? [],
    removed: update?.removed ?? [],
    customized: update?.customized ?? [],
    unused: update?.unused ?? [],
  }));
}

/** What a plan does to the project's files, its lockfile, and its env files. */
export function planReport(plan: Pick<UpdatePlan, "actions" | "envs" | "lockfile">) {
  const files = fileReports(plan);
  const conflicted = files.filter((file) => file.action === "conflict");
  return {
    files,
    lockfile: plan.lockfile.kind,
    envFiles: envFileReports(plan),
    conflicts: { files: conflicted.length, blocks: conflicted.reduce((sum, file) => sum + (file.conflicts ?? 0), 0) },
  };
}

/** The Starter releases an upgrade crosses, with a link to each one's notes. */
export function releaseReports(repository: string, releases: Release[]): ReleaseReport[] {
  return releases.map((release) => ({
    tag: release.tag,
    name: release.name,
    url: `https://github.com/${repository}/releases/tag/${release.tag}`,
    headings: releaseHeadings(release.body),
  }));
}
