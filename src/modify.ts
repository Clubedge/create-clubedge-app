// `add`, `remove`, and `upgrade` change an existing project. The project's recorded Starter
// commit, apps, and modules (base) and the new state (target: other modules or apps, or a newer
// Starter) are rendered in memory, and the difference is merged into the project (see
// core/update.ts).
import { confirm, isCancel, log, multiselect, outro, select, spinner } from "@clack/prompts";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import type { Writable } from "node:stream";
import { UsageError, type CliArgs } from "./cli/args.js";
import { dim } from "./cli/ui.js";
import { runsServer } from "./core/manifest-fields.js";
import { readTemplateManifest, type TemplateManifest } from "./core/manifest.js";
import { compareVersions, type ConflictedFile } from "./core/health.js";
import { countConflicts, type MergeAction } from "./core/merge.js";
import { unusedPatches, unusedPatchWarning } from "./core/patches.js";
import { describeReleases, fetchReleases, releasesBetween, type Release } from "./core/releases.js";
import { emptyReport, planReport, releaseReports, type ChangeReport, type InstallReport, type ProjectState } from "./core/report.js";
import { moduleChoices, NO_STACK, selectModules, selectStacks, slotChoices, stacksIn } from "./core/plan.js";
import { readProject, type Project } from "./core/project.js";
import { belowStableWarning, choicesBelowStable, deprecationNotes, newChoices, refuseUnoffered, stabilityUrl } from "./core/support.js";
import {
  downloadGitHubTemplate,
  readDirectoryTemplate,
  resolveTemplateSource,
  type TemplateSource,
} from "./core/source.js";
import { applyUpdate, findConflictedFiles, INCOMING_DIR, planUpdate, type UpdatePlan, type UpdateSide } from "./core/update.js";
import { cliVersion, starterPin } from "./package-info.js";
import { parseEnvFile } from "./core/deploy.js";
import { describeNewDatabase, projectDatabaseEnv, provisionNeonDatabase } from "./neon.js";
import { detectPnpm, installDependencies } from "./steps/install.js";
import { listTemplateFiles, pathExists } from "./utils/fs.js";
import { commandSucceeds, runCapture } from "./utils/process.js";

type ChangeCommand = Extract<CliArgs["command"], { name: "add" | "remove" | "upgrade" }>;
/**
 * add or remove with every argument known. A change names a module, or an app's slot such as
 * `mobile` with its stack (`add mobile expo`), which `remove` empties.
 */
type ModuleCommand =
  | { name: "add"; changes: Array<{ module: string; option: string }> }
  | { name: "remove"; modules: string[] };

/**
 * The slots add and remove can fill or empty: those of the apps installed on devices, a shell or a
 * mobile app, which run no server. The framework and the API are chosen when a project is
 * created, since its deployment, database, and data are built around them.
 */
export function appSlots(manifest: TemplateManifest): string[] {
  return Object.keys(manifest.slots).filter((id) => manifest.slots[id]!.roles.every((role) => !runsServer(role)));
}

/**
 * Where a change runs and what it reports to: the CLI runs it in the current folder and prints to
 * the terminal; --json and the engine (engine.ts) send the log elsewhere and read the report.
 */
export interface ChangeContext {
  /** A folder inside the project; the current folder when unset. */
  root?: string;
  /** Where the log and pnpm's output go, such as process.stderr; the terminal when unset. */
  output?: Writable;
  /** Filled in as the change goes, even when it fails. */
  report?: ChangeReport;
}

/**
 * The log of a change: clack's, written to `output` when there is one. Without one, each call
 * passes the message alone, as the terminal's always did.
 */
function changeUi(output?: Writable) {
  const options = output ? { output } : undefined;
  const say =
    (write: (message: string, options?: { output: Writable }) => void) =>
    (message: string) =>
      options ? write(message, options) : write(message);
  return {
    info: say(log.info),
    warn: say(log.warn),
    success: say(log.success),
    message: say(log.message),
    outro: say(outro),
    spinner: () => (options ? spinner(options) : spinner()),
  };
}

type ChangeUi = ReturnType<typeof changeUi>;

/** Choices in a sentence: "a", "a or b", or "a, b, or c". */
const orList = (names: string[]) => (names.length > 2 ? `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}` : names.join(" or "));

/** A slot's name inside a sentence: "the framework", "the mobile app", but "the API". */
const lowerName = (name: string) => (/^[A-Z]{2,}$/.test(name) ? name : name.toLowerCase());

/** The stack a project, or one side of a change, has in a slot, or none. */
const stackIn = (side: { stacks?: Record<string, string> }, slotId: string) => side.stacks?.[slotId] ?? NO_STACK;

/** The stacks of an app slot that fit the project's other apps, for prompts. */
function addableStacks(manifest: TemplateManifest, project: Project, slotId: string): string[] {
  const { [slotId]: _, ...others } = selectStacks(manifest, project.stacks);
  return slotChoices(manifest, slotId, others).filter((id) => id !== NO_STACK && id !== stackIn(project, slotId));
}

/** How to run the CLI in this project: its `clubedge` script when it has one. */
export async function cliCommand(project: Project): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(join(project.root, "package.json"), "utf8"));
    if (manifest.scripts?.clubedge) return "pnpm clubedge";
  } catch {
    // Fall back to the full command below.
  }
  return "pnpm dlx @clubedge/create-clubedge-app";
}

/** The Starter revision the project was generated from. */
async function projectSource(project: Project, templateDir: string | undefined): Promise<TemplateSource> {
  if (templateDir) return readDirectoryTemplate(templateDir);
  if (!project.starterCommit) {
    throw new UsageError(
      `This project records no Starter commit (Starter "${project.starterRef}"), so the CLI cannot fetch the revision it came from. Pass --template-dir with that Starter checkout.`,
    );
  }
  if (project.starterCommit === starterPin.starterCommit) return resolveTemplateSource({});
  return downloadGitHubTemplate(project.starterCommit, { repository: project.starterRepository });
}

/** The Starter to upgrade to: --template-dir, --ref, or the release this CLI is pinned to. */
async function upgradeSource(args: CliArgs): Promise<TemplateSource> {
  if (args.templateDir) return readDirectoryTemplate(args.templateDir);
  return resolveTemplateSource({ ref: args.ref });
}

/**
 * Renders the project's own revision with the provenance it recorded, so the generated
 * package.json and README match the project even when the revision was fetched by commit.
 */
function asRecorded(source: TemplateSource, project: Project): UpdateSide["source"] {
  return { ...source, ref: project.starterRef, commit: project.starterCommit };
}

/**
 * Why a project with conflict markers left by an earlier change cannot change yet: the new merge
 * would run over them, and once wrote its own markers inside the old ones, and otherwise carried
 * the old ones on, with exit code 0 when it added none.
 */
export function unresolvedConflictsError(conflicts: ConflictedFile[]): string {
  const total = conflicts.reduce((sum, c) => sum + c.blocks, 0);
  const files = conflicts
    .slice(0, 5)
    .map((c) => `\n  ${c.path} (${c.blocks} ${c.blocks === 1 ? "block" : "blocks"})`)
    .join("");
  const more = conflicts.length > 5 ? `\n  ... and ${conflicts.length - 5} more files` : "";
  return (
    `${conflicts.length === 1 ? "A file still has" : `${conflicts.length} files still have`} conflict markers from an earlier change ` +
    `(${total} ${total === 1 ? "block" : "blocks"}):${files}${more}\n` +
    "This change would merge into them. Resolve them first: keep your lines, the Starter's, or a mix, and delete the markers. " +
    "Pass --force to change the project anyway."
  );
}

/**
 * Refuses to change a project, unless --force, that still has conflict markers from an earlier
 * change, or whose changes Git cannot show and undo: a Git repository must have no uncommitted
 * changes, and a folder without Git needs confirmation.
 */
async function assertSafeToChange(project: Project, args: CliArgs, interactive: boolean) {
  if (args.force) return;
  // First: committing the markers would clear the uncommitted changes, not the conflicts.
  const conflicts = await findConflictedFiles(project.root);
  if (conflicts.length) throw new UsageError(unresolvedConflictsError(conflicts));
  const isRepository = await commandSucceeds("git", ["-C", project.root, "rev-parse", "--is-inside-work-tree"]);
  if (isRepository) {
    const status = await runCapture("git", ["-C", project.root, "status", "--porcelain"]);
    if (status) {
      throw new UsageError(
        "The project has uncommitted changes. Commit or stash them first, so you can review this change with `git diff` and undo it if needed, or pass --force.",
      );
    }
    return;
  }
  if (!interactive) {
    throw new UsageError("The project is not a Git repository, so this change could not be undone. Pass --force to change it anyway.");
  }
  const proceed = await confirm({
    message: "The project is not a Git repository, so this change cannot be undone. Continue?",
    initialValue: false,
  });
  if (isCancel(proceed) || !proceed) throw new UsageError("Cancelled; nothing was changed.");
}

/** Whether the project's stacks implement an option and its requirements hold for the other modules. */
function available(manifest: TemplateManifest, project: Project, moduleId: string, optionId: string) {
  const option = manifest.modules[moduleId]!.options[optionId]!;
  return (
    moduleChoices(manifest, selectStacks(manifest, project.stacks), moduleId, project.modules).includes(optionId) &&
    Object.entries(option.requires).every(([other, allowed]) => allowed.includes(project.modules[other] ?? ""))
  );
}

/**
 * Asks for whatever add or remove was not given: the module, then the option. Without a
 * terminal, the missing arguments are an error. Resolves null when a prompt is cancelled.
 */
export async function completeCommand(
  manifest: TemplateManifest,
  project: Project,
  command: Exclude<ChangeCommand, { name: "upgrade" }>,
  interactive: boolean,
): Promise<ModuleCommand | null> {
  if (command.name === "add" && command.changes.length && command.changes.every((change) => change.option)) {
    return { name: "add", changes: command.changes.map(({ module, option }) => ({ module, option: option! })) };
  }
  if (command.name === "remove" && command.modules.length) return { name: "remove", modules: command.modules };
  if (!interactive) {
    throw new UsageError(
      command.name === "add"
        ? "Usage: add <module> <option>, for example: add cache redis, or add mobile expo. Run it in a terminal to choose from a list."
        : "Usage: remove <module>, for example: remove storage, or remove mobile. Run it in a terminal to choose from a list.",
    );
  }

  // The apps and modules: named on the command line, or picked from a list (several at once).
  let moduleIds = command.name === "add" ? command.changes.map((change) => change.module) : [];
  if (!moduleIds.length) {
    const apps = appSlots(manifest).filter((id) =>
      command.name === "add" ? addableStacks(manifest, project, id).length > 0 : stackIn(project, id) !== NO_STACK,
    );
    const choices = Object.entries(manifest.modules).filter(([id, module]) =>
      command.name === "add" ? true : Boolean(module.options.none) && project.modules[id] !== "none",
    );
    if (!choices.length && !apps.length) throw new UsageError("Nothing can be removed: every removable module is already none, and the project has no app to remove.");
    const value = await multiselect({
      message:
        command.name === "add"
          ? "What do you want to add or switch? (space to pick, enter to confirm)"
          : "What do you want to remove? (space to pick, enter to confirm)",
      required: true,
      options: [
        ...apps.map((id) => ({
          value: id,
          label: manifest.slots[id]!.name,
          hint: `now: ${manifest.stacks[stackIn(project, id)]?.name ?? "none"}`,
        })),
        ...choices.map(([id, module]) => ({
          value: id,
          label: module.name,
          hint: `now: ${module.options[project.modules[id] ?? ""]?.name ?? project.modules[id] ?? "not set"}`,
        })),
      ],
    });
    if (isCancel(value)) return null;
    moduleIds = value;
  }
  if (command.name === "remove") return { name: "remove", modules: moduleIds };

  // Then an option for each module, or a stack for each app, that was not given one. They apply
  // together, so options that only work together (Supabase Auth with Supabase Storage) can be
  // picked in one go.
  const changes: Array<{ module: string; option: string }> = [];
  for (const moduleId of moduleIds) {
    const given = command.changes.find((change) => change.module === moduleId)?.option;
    if (given) {
      changes.push({ module: moduleId, option: given });
      continue;
    }
    const slot = appSlots(manifest).includes(moduleId) ? manifest.slots[moduleId]! : undefined;
    if (slot) {
      // With one stack that fits, there is nothing to ask; with none, the change says why.
      const stacks = addableStacks(manifest, project, moduleId);
      if (stacks.length > 1) {
        const stack = await select({
          message: `${slot.name}: which one?`,
          options: stacks.map((id) => ({ value: id, label: manifest.stacks[id]!.name })),
        });
        if (isCancel(stack)) return null;
        changes.push({ module: moduleId, option: stack });
      } else {
        changes.push({ module: moduleId, option: stacks[0] ?? stacksIn(manifest, moduleId)[0] ?? NO_STACK });
      }
      continue;
    }
    const module = manifest.modules[moduleId];
    if (!module) {
      throw new UsageError(`Unknown module "${moduleId}". Choose one of: ${Object.keys(manifest.modules).join(", ")}.`);
    }
    const options = Object.keys(module.options).filter(
      (id) => id !== project.modules[moduleId] && (moduleIds.length > 1 || available(manifest, project, moduleId, id)),
    );
    if (!options.length) throw new UsageError(`${module.name} has no other option this project can use.`);
    const option = await select({
      message: `${module.name}: which option?`,
      options: options.map((id) => ({
        value: id,
        label: module.options[id]!.name,
        ...(id === module.default ? { hint: "default" } : {}),
      })),
    });
    if (isCancel(option)) return null;
    changes.push({ module: moduleId, option });
  }
  return { name: "add", changes };
}

/**
 * Why a project cannot take the app added to `slotId`, in terms of what it would need: add and
 * remove never change the framework or the API, so the way there is a new project. Null when
 * the app fits its role, and the Starter's own rules decide.
 */
function appConflict(manifest: TemplateManifest, stacks: Record<string, string>, slotId: string): string | null {
  const app = manifest.stacks[stacks[slotId] ?? ""];
  if (!app) return null;
  const selected = Object.values(selectStacksLoosely(manifest, stacks)).flatMap((id) => manifest.stacks[id] ?? []);
  const withRole = (role: string) => selected.find((stack) => stack.role === role);
  const ids = (role: string) => Object.keys(manifest.stacks).filter((id) => manifest.stacks[id]!.role === role);
  const fixed = "A project's framework and API are chosen when it is created, so add cannot change them";
  if (app.role === "mobile" && !withRole("api")) {
    const site = withRole("fullstack");
    return (
      `${app.name} calls the project's API, and this project has none${site ? `: ${site.name} serves its own pages` : ""}. ` +
      `${fixed}: for ${app.name}, create a project with --framework ${orList([...ids("frontend"), NO_STACK])}, and --api ${orList(ids("api"))}.`
    );
  }
  if (app.role === "shell" && !withRole("frontend")) {
    const site = withRole("fullstack");
    return (
      `${app.name} packages a frontend's static files, and ${site ? `${site.name} renders its pages on its server` : "this project has no website"}. ` +
      `${fixed}: for ${app.name}, create a project with --framework ${orList(ids("frontend"))}.`
    );
  }
  return null;
}

/** The stack per slot as recorded, with each empty slot's default, without checking roles. */
function selectStacksLoosely(manifest: TemplateManifest, stacks: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(manifest.slots).map(([id, slot]) => [id, stacks[id] ?? slot.default ?? NO_STACK]),
  );
}

/**
 * The apps and modules after add or remove, validated against the Starter's manifest. Every
 * change applies before requirements are checked, so changes that only work together, such as
 * Supabase Auth with Supabase Storage, or the native app with an auth it implements, can be made
 * in one command. `stacks` keeps the project's recorded form, with the changed app slots set.
 */
export function changedSelection(manifest: TemplateManifest, project: Project, command: ModuleCommand, cli: string) {
  const changes =
    command.name === "add" ? command.changes : command.modules.map((module) => ({ module, option: NO_STACK }));
  const apps = appSlots(manifest);
  const stacks: Record<string, string> = { ...project.stacks };
  const changedApps: string[] = [];
  const requested = { ...project.modules };
  for (const { module: id, option } of changes) {
    const slot = manifest.slots[id];
    if (slot) {
      if (!apps.includes(id)) {
        throw new UsageError(
          `The ${lowerName(slot.name)} is chosen when a project is created: add and remove change modules${apps.length ? ` and the apps installed on devices (${apps.join(", ")})` : ""}.`,
        );
      }
      const offered = stacksIn(manifest, id);
      if (option !== NO_STACK && !offered.includes(option)) {
        throw new UsageError(`Unknown ${lowerName(slot.name)} "${option}". Choose one of: ${offered.join(", ")}.`);
      }
      stacks[id] = option;
      changedApps.push(id);
      continue;
    }
    const module = manifest.modules[id];
    if (!module) {
      throw new UsageError(
        `Unknown module "${id}". Choose one of: ${Object.keys(manifest.modules).join(", ")}${apps.length ? `, or an app: ${apps.join(", ")}` : ""}.`,
      );
    }
    if (command.name === "remove" && !module.options.none) {
      const others = Object.keys(module.options).filter((other) => other !== project.modules[id]);
      throw new UsageError(
        `${module.name} cannot be removed. Switch it instead, for example: ${cli} add ${id} ${others[0] ?? module.default}`,
      );
    }
    if (!module.options[option]) {
      throw new UsageError(`Unknown ${id} option "${option}". Choose one of: ${Object.keys(module.options).join(", ")}.`);
    }
    requested[id] = option;
  }

  // An added app must fit the project's other apps, and implement the modules it uses: a module
  // option it lacks can be switched in the same command.
  for (const slotId of changedApps) {
    const conflict = appConflict(manifest, stacks, slotId);
    if (conflict) throw new UsageError(conflict);
    const app = manifest.stacks[stacks[slotId]!];
    for (const [moduleId, implemented] of Object.entries(app?.modules ?? {})) {
      const option = requested[moduleId];
      if (option === undefined || implemented.includes(option)) continue;
      const module = manifest.modules[moduleId]!;
      throw new UsageError(
        `${app!.name} does not implement ${module.options[option]?.name ?? option} (${moduleId} ${option}). It implements: ${implemented.join(", ")}. ` +
          `Switch it in the same command, for example: ${cli} add ${slotId} ${stacks[slotId]} ${moduleId} ${implemented.find((id) => id !== NO_STACK) ?? implemented[0]}`,
      );
    }
  }
  // Validates the Starter's rules for the apps, requirements between modules, such as Supabase
  // Storage needing Supabase Auth, and that the project's stacks implement the new options.
  const selection = selectStacks(manifest, stacks);
  return { stacks, modules: selectModules(manifest, requested, selection), apps: changedApps };
}

/** The modules after add or remove (see changedSelection). */
export function changedModules(manifest: TemplateManifest, project: Project, command: ModuleCommand, cli: string) {
  return changedSelection(manifest, project, command, cli).modules;
}

/**
 * What Starters before v0.5.0 built in: Supabase Auth, S3 storage, and a Redis cache. v0.5.0 made
 * them its first modules, with these options as defaults. Projects from those Starters record no
 * modules, and an upgrade keeps these rather than taking them out as modules the project predates.
 */
export const BUILT_IN_BEFORE_MODULES: Readonly<Record<string, string>> = { auth: "supabase", storage: "s3", cache: "redis" };

/**
 * The project's selection in a newer Starter. Modules the project predates get their "none"
 * option where there is one, so an upgrade never adds a service on its own.
 */
export function upgradedModules(manifest: TemplateManifest, project: Project, cli = "pnpm clubedge") {
  const requested: Record<string, string> = {};
  const introduced: string[] = [];
  for (const [id, module] of Object.entries(manifest.modules)) {
    const recorded = project.modules[id];
    if (recorded === undefined) {
      requested[id] = module.options.none ? "none" : module.default;
      introduced.push(id);
    } else if (!module.options[recorded]) {
      // A Starter that removed an option keeps a record of it, naming what replaces it.
      const removed = module.removed?.[recorded];
      const replacement = removed?.replacement && module.options[removed.replacement] ? removed.replacement : undefined;
      const switchTo = replacement
        ? `Switch to ${module.options[replacement]!.name} with ${cli} add ${id} ${replacement} before upgrading: it changes the project on its own Starter release.`
        : `Switch to one of ${Object.keys(module.options).join(", ")} with ${cli} add ${id} <option> before upgrading.`;
      throw new UsageError(
        `The new Starter no longer offers ${module.name} "${recorded}"${removed?.since ? ` (removed in ${removed.since})` : ""}. ${switchTo}` +
          (removed?.note ? ` ${removed.note}` : ""),
      );
    } else {
      requested[id] = recorded;
    }
  }
  const dropped = Object.keys(project.modules).filter((id) => !manifest.modules[id]);
  return { modules: selectModules(manifest, requested, selectStacks(manifest, project.stacks)), introduced, dropped };
}

const verbs: Record<MergeAction["kind"], string> = {
  create: "add",
  update: "update",
  merge: "merge",
  conflict: "conflict",
  delete: "delete",
  keep: "keep",
};

function describe(plan: UpdatePlan): string {
  const lines = plan.actions.map((action) => `${verbs[action.kind].padEnd(8)} ${action.path}`);
  if (plan.lockfile.kind === "replace") lines.push(`${"update".padEnd(8)} pnpm-lock.yaml`);
  if (plan.lockfile.kind === "install") lines.push(`${"install".padEnd(8)} pnpm-lock.yaml ${dim("(pnpm install reconciles your dependency changes)")}`);
  for (const { path, update: env, changed, create } of plan.envs) {
    if (create) lines.push(`${"add".padEnd(8)} ${path} ${dim("(from its example)")}`);
    if (!env || !changed) continue;
    const parts = [
      env.added.length ? `adds ${env.added.join(", ")}` : "",
      env.updated.length ? `updates ${env.updated.join(", ")}` : "",
      env.removed.length ? `removes ${env.removed.join(", ")}` : "",
    ].filter(Boolean);
    lines.push(`${"update".padEnd(8)} ${path} ${dim(`(${parts.length ? parts.join("; ") : "comments follow the example"})`)}`);
  }
  return lines.join("\n");
}

/**
 * How many files a change writes, as its list shows them: the files it changes, the lockfile it
 * replaces, and the env files it adds to or creates. The files left for you to check are not.
 */
function writtenFiles(plan: UpdatePlan): number {
  return (
    plan.actions.filter((action) => action.kind !== "keep").length +
    (plan.lockfile.kind === "replace" ? 1 : 0) +
    plan.envs.filter((env) => env.create || (env.update && env.changed)).length
  );
}

const conflictsOf = (plan: UpdatePlan) =>
  plan.actions.filter((action): action is Extract<MergeAction, { kind: "conflict" }> => action.kind === "conflict");

/**
 * The project's package.json files with conflict markers: this change's, and any an earlier change
 * left that this one does not touch, which its plan does not list.
 */
async function conflictedManifests(root: string): Promise<string[]> {
  const manifests = (await listTemplateFiles(root)).filter((path) => /(^|\/)package\.json$/.test(path));
  const conflicted = await Promise.all(
    manifests.map(async (path) => (countConflicts(await readFile(join(root, path))) ? path : null)),
  );
  return conflicted.filter((path): path is string => path !== null);
}

/**
 * Why pnpm cannot run yet: it reads every package.json in the workspace and stops at one with
 * conflict markers, so `pnpm install` and `pnpm clubedge` fail until they are resolved.
 */
function conflictedManifestWarning(paths: string[], install: boolean): string {
  const one = paths.length === 1;
  return (
    `${install ? "Skipped `pnpm install`: " : ""}${paths.join(", ")} ${one ? "has" : "have"} conflict markers, which pnpm cannot read, ` +
    `so pnpm commands, \`pnpm clubedge\` among them, fail until ${one ? "it is" : "they are"} resolved. Then run \`pnpm install\`.`
  );
}

/** "3 conflicts in 2 files", and a line per file with its blocks. */
function describeConflicts(conflicts: Array<Extract<MergeAction, { kind: "conflict" }>>) {
  const blocks = conflicts.map((action) => countConflicts(action.content));
  const total = blocks.reduce((sum, count) => sum + count, 0);
  return {
    amount: `${total} ${total === 1 ? "conflict" : "conflicts"} in ${conflicts.length} ${conflicts.length === 1 ? "file" : "files"}`,
    files: conflicts.map((action, i) => `  ${action.path} ${dim(`(${blocks[i]} ${blocks[i] === 1 ? "block" : "blocks"})`)}`).join("\n"),
  };
}

function reportPlan(plan: UpdatePlan, ui: ChangeUi) {
  const conflicts = conflictsOf(plan);
  const kept = plan.actions.filter((action): action is Extract<MergeAction, { kind: "keep" }> => action.kind === "keep");
  const incoming = (path: string) => `${INCOMING_DIR}/${path}`;
  if (conflicts.length) {
    const { amount, files } = describeConflicts(conflicts);
    const first = conflicts[0]!.path;
    ui.warn(
      `Resolve ${amount}. ` +
        "Each is marked <<<<<<< yours ... ======= ... >>>>>>> clubedge: keep your lines, the Starter's, or a mix, then delete the markers.\n" +
        files +
        `\n\nThe Starter's whole new version of each is in ${INCOMING_DIR}/, to compare with yours:\n` +
        `  git diff --no-index ${first} ${incoming(first)}\n` +
        dim(`Git ignores ${INCOMING_DIR.split("/")[0]}/; delete it when you are done.`),
    );
  }
  if (kept.length) {
    ui.info(
      `Check these files by hand:\n${kept
        .map((action) => `  ${action.path}: ${action.reason}${action.incoming ? dim(` The Starter's version: ${incoming(action.path)}`) : ""}`)
        .join("\n")}`,
    );
  }
  for (const { path, update: env, create } of plan.envs) {
    if (!env) {
      if (!create) ui.info(`${path} does not exist yet; create it from the example file.`);
      continue;
    }
    if (env.customized.length) {
      ui.info(
        `You set your own ${env.customized.join(", ")} in ${path}; the example's value changed, so check whether yours still fits.`,
      );
    }
    if (env.unused.length) {
      ui.info(`The project no longer uses ${env.unused.join(", ")}, which you set in ${path}. Remove them when you no longer need them.`);
    }
  }
}

interface Change {
  base: UpdateSide;
  target: UpdateSide;
  /** One line describing the change, such as "Starter v0.6.0 -> v0.7.0". */
  summary: string;
  /** upgrade: the modules the new Starter has and the project's did not, which the project leaves off. */
  introduced: string[];
  notes: string[];
  /** add: the new choices below stable, which still work; see the Starter's STABILITY.md. */
  warnings: string[];
  /** upgrade: the Starter releases it crosses, one line each, or why GitHub could not list them. */
  releases?: string;
  /** upgrade: the same releases, oldest first, or null when GitHub could not list them. */
  crossed: Release[] | null;
  /** add and remove: the app slots the change fills or empties. */
  apps: string[];
}

/** Works out what the command changes; resolves null when the project is already there. */
async function planChange(
  project: Project,
  command: ModuleCommand | { name: "upgrade" },
  base: TemplateSource,
  baseManifest: TemplateManifest,
  target: TemplateSource | null,
  cli: string,
): Promise<Change | null> {
  const baseSide = {
    source: asRecorded(base, project),
    manifest: baseManifest,
    stacks: project.stacks,
    modules: project.modules,
    cliVersion: project.cliVersion,
  };

  if (command.name !== "upgrade") {
    const { stacks, modules, apps } = changedSelection(baseManifest, project, command, cli);
    const changedApps = apps.filter((id) => stackIn({ stacks }, id) !== stackIn(project, id));
    const changed = Object.keys(modules).filter((id) => modules[id] !== project.modules[id]);
    if (!changed.length && !changedApps.length) return null;
    // Only the choices this command makes: an option the project already has is not new to it.
    const before = { stacks: project.stacks, modules: project.modules };
    refuseUnoffered(baseManifest, newChoices(baseManifest, stacks, modules, before), "argument");
    const belowStable = choicesBelowStable(baseManifest, stacks, modules, before);
    const levels = belowStableWarning(baseManifest, belowStable, "argument", stabilityUrl({ kind: base.kind, repository: base.repository, ref: project.starterRef }));
    const stackName = (id: string) => baseManifest.stacks[id]?.name ?? NO_STACK;
    return {
      base: baseSide,
      target: { ...baseSide, stacks, modules, cliVersion },
      summary: [
        ...changedApps.map((id) => `${baseManifest.slots[id]!.name}: ${stackName(stackIn(project, id))} -> ${stackName(stackIn({ stacks }, id))}`),
        ...changed.map((id) => `${baseManifest.modules[id]!.name}: ${project.modules[id]} -> ${modules[id]}`),
      ].join(", "),
      introduced: [],
      notes: [],
      warnings: levels ? [levels] : [],
      crossed: [],
      apps: changedApps,
    };
  }

  if (!target) throw new Error("upgrade needs a target Starter.");
  if (!target.commit && target.kind === "github") {
    throw new UsageError(`Could not resolve Starter "${target.ref}" to a commit. Use a tag, a branch, or a full commit SHA.`);
  }
  if (target.commit && target.commit === project.starterCommit) return null;
  const targetManifest = await readTemplateManifest(target.root);
  // A Starter before modules built in what became the first ones, and its project keeps them.
  const builtIn = !Object.keys(baseManifest.modules).length && Object.keys(targetManifest.modules).length > 0;
  const keptModules = Object.fromEntries(Object.entries(BUILT_IN_BEFORE_MODULES).filter(([id]) => targetManifest.modules[id]));
  const recorded = builtIn ? { ...project, modules: keptModules } : project;
  const { modules, introduced, dropped } = upgradedModules(targetManifest, recorded, cli);
  const notes = dropped.map((id) => `Starter ${target.ref} no longer has the ${id} module; its files are merged away like any other change.`);
  if (builtIn && Object.keys(keptModules).length) {
    const kept = Object.entries(keptModules).map(
      ([id, option]) => `${targetManifest.modules[id]!.name}: ${targetManifest.modules[id]!.options[option]?.name ?? option}`,
    );
    notes.unshift(
      `Starter ${project.starterRef} had no modules yet, but built in what became the first ones, so the project keeps them: ${kept.join(", ")}. Switch one with: ${cli} add <module> <option>`,
    );
  }
  notes.push(...deprecationNotes(targetManifest, project.stacks, modules, cli));
  if (/^v\d/.test(target.ref)) {
    notes.push(`Release notes: https://github.com/${target.repository}/releases/tag/${target.ref}`);
  }
  let releases: string | undefined;
  let crossed: Release[] | null = [];
  if (compareVersions(project.starterRef, target.ref) !== null) {
    const published = await fetchReleases(target.repository);
    crossed = published ? releasesBetween(published, project.starterRef, target.ref) : null;
    if (crossed?.length) releases = `Starter releases in this upgrade:\n${describeReleases(crossed)}`;
    else if (!published) {
      releases =
        "Could not list the Starter releases in this upgrade: GitHub could not be reached, or refused, as it does past its rate limit " +
        `(GITHUB_TOKEN raises it). They are at https://github.com/${target.repository}/releases.`;
    }
  }
  return {
    base: baseSide,
    target: { source: target, manifest: targetManifest, stacks: project.stacks, modules, cliVersion },
    summary: `Starter ${project.starterRef} -> ${target.ref}`,
    introduced,
    notes,
    warnings: [],
    releases,
    crossed,
    apps: [],
  };
}

/**
 * A note for each module the upgrade brings that the project leaves off. It names the project's
 * own Starter release, which did not have the module: an upgrade can cross several releases, and
 * the target is not always the one that added it (push notifications came in v0.30.0, and an
 * upgrade from v0.26.0 to v0.31.0 said v0.31.0 added them).
 */
function introducedNotes(project: Project, change: Change, cli: string, pnpmBlocked = false): string[] {
  const { manifest, modules } = change.target;
  // While a package.json has conflict markers, pnpm cannot run the CLI's script.
  const choose = pnpmBlocked ? "Once the package.json conflicts are resolved, choose another option with" : "Choose another option with";
  return change.introduced.map(
    (id) =>
      `${manifest.modules[id]!.name} is new since Starter ${project.starterRef}; the project uses "${modules[id]}". ` +
      `${choose}: ${cli} add ${id} <option>`,
  );
}

/**
 * What to run after a change. A typecheck always: files that merged without conflicts can still
 * break the code, as when an upgrade gave Chess two copies of one function, outside any marker.
 * With conflicts, resolving them comes first, then the install pnpm could not run.
 */
function closingLine(upgrading: boolean, conflicts: boolean, installSkipped: boolean): string {
  const review = "review the changes with `git diff`, and run `pnpm typecheck` and your tests: files that merged cleanly can still break the code";
  const next = upgrading
    ? "Run `pnpm db:migrate` for new migrations."
    : "Run `pnpm check:services` and `pnpm db:migrate` if the change added services or tables.";
  if (!conflicts) return `R${review.slice(1)}. ${next}`;
  return `Resolve the conflicts first${installSkipped ? ", then run `pnpm install`" : ""}. Then ${review}. ${next}`;
}

/**
 * After `add infra neon`: a free Neon database when the env file's DATABASE_URL is empty, which it
 * is when it still held the old infra's example value. A URL the developer set stays.
 */
async function addNeonDatabase(project: Project, args: CliArgs, cli: string, ui: ChangeUi, report: ChangeReport) {
  const { envPath, shared } = projectDatabaseEnv(project);
  const env = parseEnvFile(await readFile(join(project.root, envPath), "utf8").catch(() => ""));
  const note = (message: string) => {
    ui.info(message);
    report.notes.push(message);
  };
  if (env.DATABASE_URL) {
    note(`DATABASE_URL in ${envPath} is yours, so it stays. Run \`${cli} neon create\` for a free Neon database instead.`);
    return;
  }
  if (!args.neon) {
    note(`Set DATABASE_URL in ${envPath}, or run \`${cli} neon create\` for a free Neon database.`);
    return;
  }
  const progress = ui.spinner();
  progress.start("Creating a free Neon database");
  try {
    const created = await provisionNeonDatabase(project.root, envPath, shared);
    const described = describeNewDatabase(created, cli);
    progress.stop(described);
    report.notes.push(described);
  } catch (error) {
    progress.stop("Neon created no database");
    const warning = `${error instanceof Error ? error.message : String(error)} Run \`${cli} neon create\` to try again.`;
    ui.warn(warning);
    report.warnings.push(warning);
  }
}

/**
 * Where an app the change adds is, and what is left of one it removes: the files that were never
 * the Starter's, such as its env file, its dependencies, or native projects, stay.
 */
async function reportApps(project: Project, change: Change, ui: ChangeUi, report: ChangeReport) {
  const { manifest } = change.target;
  for (const slotId of change.apps) {
    const slot = manifest.slots[slotId]!;
    const stack = manifest.stacks[stackIn(change.target, slotId)];
    if (stack) {
      const note = `${stack.name} is in ${slot.path}, with its settings in ${slot.env.target}. SETUP.md now has the steps to run and build it.`;
      ui.info(note);
      report.notes.push(note);
      continue;
    }
    const folder = join(project.root, slot.path);
    const left = (await pathExists(folder)) ? (await readdir(folder)).sort() : [];
    if (!left.length) continue;
    const shown = `${left.slice(0, 4).join(", ")}${left.length > 4 ? ", ..." : ""}`;
    const note = `${slot.path} still holds what was never the Starter's (${shown}): its settings, dependencies, or native projects. Delete the folder once you no longer need them.`;
    ui.info(note);
    report.notes.push(note);
  }
}

/**
 * What add, remove, or upgrade did: "conflicts" when it wrote conflict markers to resolve, or a
 * dry run found it would.
 */
export type ChangeOutcome = "unchanged" | "changed" | "conflicts";

/** A Starter and a selection, as the project's package.json records them, for the report. */
function projectState(
  source: { repository: string; ref: string; commit?: string },
  stacks: Record<string, string>,
  modules: Record<string, string>,
): ProjectState {
  return { repository: source.repository, ref: source.ref, ...(source.commit ? { commit: source.commit } : {}), stacks, modules };
}

/**
 * pnpm install's arguments for a change. --lockfile-only writes pnpm-lock.yaml and nothing else,
 * and runs nothing from the project, neither lifecycle scripts nor a .pnpmfile.cjs, so a service
 * can update the lockfile of code it does not trust. It always reconciles: that is its purpose,
 * and CI, where pnpm freezes the lockfile by default, is where it runs.
 */
export function installArguments(mode: Exclude<InstallReport["mode"], "none">, lockfile: UpdatePlan["lockfile"]["kind"]): string[] {
  if (mode === "lockfile-only") return ["--lockfile-only", "--ignore-scripts", "--ignore-pnpmfile", "--no-frozen-lockfile"];
  return lockfile === "install" ? ["--no-frozen-lockfile"] : [];
}

export async function changeProject(args: CliArgs, context: ChangeContext = {}): Promise<ChangeOutcome> {
  const command = args.command;
  if (command.name !== "add" && command.name !== "remove" && command.name !== "upgrade") throw new Error("Not a project change.");
  const ui = changeUi(context.output);
  const report = context.report ?? emptyReport(command.name, cliVersion, args.dryRun);
  // A report is read by a program, which cannot answer a prompt.
  const interactive = Boolean(process.stdin.isTTY) && !args.yes && !args.json;
  const project = await readProject(context.root ?? process.cwd());
  report.from = projectState(
    { repository: project.starterRepository, ref: project.starterRef, commit: project.starterCommit },
    project.stacks,
    project.modules,
  );
  const unchanged = (message: string): ChangeOutcome => {
    ui.outro(message);
    report.notes.push(message);
    return "unchanged";
  };
  const upgrading = command.name === "upgrade";
  if (
    upgrading &&
    !args.templateDir &&
    project.starterCommit &&
    (args.ref ? args.ref === project.starterCommit : project.starterCommit === starterPin.starterCommit)
  ) {
    return unchanged(`The project is already on Starter ${project.starterRef}.`);
  }

  if (
    command.name === "add" &&
    command.changes.length > 0 &&
    command.changes.every((c) => c.option && (project.modules[c.module] ?? project.stacks[c.module]) === c.option)
  ) {
    return unchanged("The project already uses that selection; nothing to change.");
  }

  if (
    command.name === "remove" &&
    command.modules.length > 0 &&
    command.modules.every((m) => project.modules[m] === "none")
  ) {
    return unchanged("The project already uses that selection; nothing to change.");
  }

  await assertSafeToChange(project, args, interactive);

  const progress = ui.spinner();
  progress.start(upgrading ? "Preparing both Starter revisions" : `Preparing Starter ${project.starterRef}`);
  const sources: TemplateSource[] = [];
  let spinning = true;
  try {
    // For upgrade, --template-dir names the new Starter; the project's own comes from GitHub.
    const base = await projectSource(project, upgrading ? undefined : args.templateDir);
    sources.push(base);
    const target = upgrading ? await upgradeSource(args) : null;
    if (target) sources.push(target);
    const baseManifest = await readTemplateManifest(base.root);
    progress.stop("Starter ready");
    spinning = false;

    const cli = await cliCommand(project);
    // Every project records the Starter's modules when it has any, so none recorded against a
    // Starter with modules means package.json lost them, and the project's files can't be told apart.
    const starterModules = Object.keys(baseManifest.modules);
    if (!Object.keys(project.modules).length && starterModules.length) {
      throw new UsageError(
        `package.json does not record this project's modules, which Starter ${project.starterRef} has, so the CLI cannot tell which of their files the project has. ` +
          `Add them to its "clubedge" field, as "modules": { "${starterModules[0]}": "<option>", ... } with one entry for each of ${starterModules.join(", ")}, then run this again.`,
      );
    }
    // Starters before v0.5.0 have no modules or apps to change; their projects upgrade first.
    if (!upgrading && !starterModules.length && !appSlots(baseManifest).length) {
      throw new UsageError(
        `Starter ${project.starterRef}, which this project comes from, has no modules or apps to ${command.name}: they came in later releases. ` +
          `Upgrade the project first with \`${cli} upgrade\`, then ${command.name} them.`,
      );
    }
    const complete =
      command.name === "upgrade" ? command : await completeCommand(baseManifest, project, command, interactive);
    if (!complete) return unchanged("Cancelled; nothing was changed.");
    const change = await planChange(project, complete, base, baseManifest, target, cli);
    if (!change) {
      return unchanged(upgrading ? `The project is already on Starter ${project.starterRef}.` : "The project already uses that selection; nothing to change.");
    }
    const plan = await planUpdate(project, change.base, change.target);
    Object.assign(report, planReport(plan), {
      summary: change.summary,
      to: projectState(change.target.source, change.target.stacks ?? project.stacks, change.target.modules),
      releases: change.crossed && releaseReports(change.target.source.repository, change.crossed),
      introduced: change.introduced.map((module) => ({ module, option: change.target.modules[module]! })),
    });
    report.warnings.push(...change.warnings);

    if (change.releases) ui.info(change.releases);
    ui.message(`${change.summary}\n\n${describe(plan) || "No file changes."}`);
    for (const warning of change.warnings) ui.warn(warning);
    if (args.dryRun) {
      const notes = [...introducedNotes(project, change, cli), ...change.notes];
      for (const note of notes) ui.info(note);
      report.notes.push(...notes);
      // Counted as the real run counts them, and reported with the same exit code.
      const conflicts = conflictsOf(plan);
      if (conflicts.length) {
        const { amount, files } = describeConflicts(conflicts);
        ui.warn(`The change would leave ${amount} to resolve, where your lines and the Starter's differ:\n${files}`);
      }
      report.next = "Dry run: nothing was changed. Run again without --dry-run to apply.";
      ui.outro(report.next);
      report.outcome = conflicts.length ? "conflicts" : "changed";
      return conflicts.length ? "conflicts" : "unchanged";
    }

    await applyUpdate(plan);
    const written = writtenFiles(plan);
    ui.success(`Updated ${written} ${written === 1 ? "file" : "files"}`);
    report.outcome = conflictsOf(plan).length ? "conflicts" : "changed";

    // The files are written now, so what is left to resolve is reported even when the install fails.
    let installError: unknown;
    const mode: InstallReport["mode"] = !args.install ? "none" : args.lockfileOnly ? "lockfile-only" : "full";
    report.install = { mode, status: "off" };
    const manifests = await conflictedManifests(project.root);
    // A patch pnpm would not use stops the install, so it is reported, and the install left until it is fixed.
    const unused = manifests.length ? [] : await unusedPatches(project.root);
    const skip = (warning: string) => {
      ui.warn(warning);
      report.warnings.push(warning);
      if (mode !== "none") report.install = { mode, status: "skipped", reason: warning };
    };
    if (manifests.length) {
      skip(conflictedManifestWarning(manifests, mode !== "none"));
    } else if (unused.length) {
      skip(unusedPatchWarning(unused, mode !== "none"));
    } else if (mode !== "none") {
      const { pnpm, problem } = await detectPnpm();
      if (pnpm) {
        try {
          // pnpm's own output goes where the log does, so --json keeps stdout for the report.
          await installDependencies(project.root, pnpm, installArguments(mode, plan.lockfile.kind), ...(context.output ? [{ output: context.output }] : []));
          ui.success(mode === "lockfile-only" ? "pnpm-lock.yaml updated, without installing" : "Dependencies updated");
          report.install = { mode, status: "done" };
        } catch (error) {
          installError = error;
          report.install = { mode, status: "failed", reason: error instanceof Error ? error.message : String(error) };
        }
      } else if (problem) {
        skip(`pnpm is installed but did not run, so dependencies were not updated. ${problem} Run \`pnpm install\` once it works.`);
      } else {
        skip("pnpm was not found. Run `pnpm install` to update dependencies.");
      }
    } else if (plan.lockfile.kind !== "unchanged") {
      ui.info("Run `pnpm install` to update dependencies.");
    }

    reportPlan(plan, ui);
    await reportApps(project, change, ui, report);
    const pnpmBlocked = manifests.length > 0;
    const notes = [...introducedNotes(project, change, cli, pnpmBlocked), ...change.notes];
    for (const note of notes) ui.info(note);
    report.notes.push(...notes);
    if (installError) {
      const reason = installError instanceof Error ? installError.message : String(installError);
      const command = mode === "lockfile-only" ? "`pnpm install --lockfile-only`" : "`pnpm install`";
      throw new Error(
        `The files were updated, but ${command} did not complete: ${reason}${reason.endsWith(".") ? "" : "."} Fix that, then run \`pnpm install\`.`,
      );
    }
    if (change.target.modules.infra === "neon" && project.modules.infra !== "neon") await addNeonDatabase(project, args, cli, ui, report);
    report.next = closingLine(upgrading, conflictsOf(plan).length > 0 || pnpmBlocked, pnpmBlocked);
    ui.outro(report.next);
    return conflictsOf(plan).length ? "conflicts" : "changed";
  } catch (error) {
    if (spinning) progress.stop("Could not prepare the Starter");
    throw error;
  } finally {
    for (const source of sources) await source.cleanup();
  }
}
