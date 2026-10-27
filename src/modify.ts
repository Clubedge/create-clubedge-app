// `add`, `remove`, and `upgrade` change an existing project. The project's recorded Starter
// commit, apps, and modules (base) and the new state (target: other modules or apps, or a newer
// Starter) are rendered in memory, and the difference is merged into the project (see
// core/update.ts).
import { confirm, isCancel, log, multiselect, outro, select, spinner } from "@clack/prompts";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { UsageError, type CliArgs } from "./cli/args.js";
import { dim } from "./cli/ui.js";
import { runsServer } from "./core/manifest-fields.js";
import { readTemplateManifest, type TemplateManifest } from "./core/manifest.js";
import { compareVersions } from "./core/health.js";
import { countConflicts, type MergeAction } from "./core/merge.js";
import { describeReleases, fetchReleases, releasesBetween } from "./core/releases.js";
import { moduleChoices, NO_STACK, selectModules, selectStacks, slotChoices, stacksIn } from "./core/plan.js";
import { readProject, type Project } from "./core/project.js";
import {
  downloadGitHubTemplate,
  readDirectoryTemplate,
  resolveTemplateSource,
  type TemplateSource,
} from "./core/source.js";
import { applyUpdate, INCOMING_DIR, planUpdate, type UpdatePlan, type UpdateSide } from "./core/update.js";
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
 * Refuses to change a project whose changes Git cannot show and undo, unless --force: a Git
 * repository must have no uncommitted changes, and a folder without Git needs confirmation.
 */
async function assertSafeToChange(project: Project, args: CliArgs, interactive: boolean) {
  if (args.force) return;
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
      throw new UsageError(
        `The new Starter no longer offers ${module.name} "${recorded}". Switch to one of ${Object.keys(module.options).join(", ")} with ${cli} add ${id} <option> before upgrading.`,
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
    lines.push(`${"update".padEnd(8)} ${path} ${dim(`(${parts.join("; ")})`)}`);
  }
  return lines.join("\n");
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

function report(plan: UpdatePlan) {
  const conflicts = conflictsOf(plan);
  const kept = plan.actions.filter((action): action is Extract<MergeAction, { kind: "keep" }> => action.kind === "keep");
  const incoming = (path: string) => `${INCOMING_DIR}/${path}`;
  if (conflicts.length) {
    const blocks = conflicts.map((action) => countConflicts(action.content));
    const total = blocks.reduce((sum, count) => sum + count, 0);
    const first = conflicts[0]!.path;
    log.warn(
      `Resolve ${total} ${total === 1 ? "conflict" : "conflicts"} in ${conflicts.length} ${conflicts.length === 1 ? "file" : "files"}. ` +
        "Each is marked <<<<<<< yours ... ======= ... >>>>>>> clubedge: keep your lines, the Starter's, or a mix, then delete the markers.\n" +
        conflicts
          .map((action, i) => `  ${action.path} ${dim(`(${blocks[i]} ${blocks[i] === 1 ? "block" : "blocks"})`)}`)
          .join("\n") +
        `\n\nThe Starter's whole new version of each is in ${INCOMING_DIR}/, to compare with yours:\n` +
        `  git diff --no-index ${first} ${incoming(first)}\n` +
        dim(`Git ignores ${INCOMING_DIR.split("/")[0]}/; delete it when you are done.`),
    );
  }
  if (kept.length) {
    log.info(
      `Check these files by hand:\n${kept
        .map((action) => `  ${action.path}: ${action.reason}${action.incoming ? dim(` The Starter's version: ${incoming(action.path)}`) : ""}`)
        .join("\n")}`,
    );
  }
  for (const { path, update: env, create } of plan.envs) {
    if (!env) {
      if (!create) log.info(`${path} does not exist yet; create it from the example file.`);
      continue;
    }
    if (env.customized.length) {
      log.info(
        `You set your own ${env.customized.join(", ")} in ${path}; the example's value changed, so check whether yours still fits.`,
      );
    }
    if (env.unused.length) {
      log.info(`The project no longer uses ${env.unused.join(", ")}, which you set in ${path}. Remove them when you no longer need them.`);
    }
  }
}

interface Change {
  base: UpdateSide;
  target: UpdateSide;
  /** One line describing the change, such as "Starter v0.6.0 -> v0.7.0". */
  summary: string;
  notes: string[];
  /** upgrade: one line per Starter release it crosses, when GitHub could be reached. */
  releases?: string;
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
    const stackName = (id: string) => baseManifest.stacks[id]?.name ?? NO_STACK;
    return {
      base: baseSide,
      target: { ...baseSide, stacks, modules, cliVersion },
      summary: [
        ...changedApps.map((id) => `${baseManifest.slots[id]!.name}: ${stackName(stackIn(project, id))} -> ${stackName(stackIn({ stacks }, id))}`),
        ...changed.map((id) => `${baseManifest.modules[id]!.name}: ${project.modules[id]} -> ${modules[id]}`),
      ].join(", "),
      notes: [],
      apps: changedApps,
    };
  }

  if (!target) throw new Error("upgrade needs a target Starter.");
  if (!target.commit && target.kind === "github") {
    throw new UsageError(`Could not resolve Starter "${target.ref}" to a commit. Use a tag, a branch, or a full commit SHA.`);
  }
  if (target.commit && target.commit === project.starterCommit) return null;
  const targetManifest = await readTemplateManifest(target.root);
  const { modules, introduced, dropped } = upgradedModules(targetManifest, project, cli);
  const notes = [
    ...introduced.map((id) => {
      const module = targetManifest.modules[id]!;
      return `Starter ${target.ref} adds ${module.name}; the project uses "${modules[id]}". Choose another option with: ${cli} add ${id} <option>`;
    }),
    ...dropped.map((id) => `Starter ${target.ref} no longer has the ${id} module; its files are merged away like any other change.`),
  ];
  if (/^v\d/.test(target.ref)) {
    notes.push(`Release notes: https://github.com/${target.repository}/releases/tag/${target.ref}`);
  }
  let releases: string | undefined;
  if (compareVersions(project.starterRef, target.ref) !== null) {
    const published = await fetchReleases(target.repository);
    const crossed = published ? releasesBetween(published, project.starterRef, target.ref) : [];
    if (crossed.length) releases = describeReleases(crossed);
  }
  return {
    base: baseSide,
    target: { source: target, manifest: targetManifest, stacks: project.stacks, modules, cliVersion },
    summary: `Starter ${project.starterRef} -> ${target.ref}`,
    notes,
    releases,
    apps: [],
  };
}

/**
 * After `add infra neon`: a free Neon database when the env file's DATABASE_URL is empty, which it
 * is when it still held the old infra's example value. A URL the developer set stays.
 */
async function addNeonDatabase(project: Project, args: CliArgs, cli: string) {
  const { envPath, shared } = projectDatabaseEnv(project);
  const env = parseEnvFile(await readFile(join(project.root, envPath), "utf8").catch(() => ""));
  if (env.DATABASE_URL) {
    log.info(`DATABASE_URL in ${envPath} is yours, so it stays. Run \`${cli} neon create\` for a free Neon database instead.`);
    return;
  }
  if (!args.neon) {
    log.info(`Set DATABASE_URL in ${envPath}, or run \`${cli} neon create\` for a free Neon database.`);
    return;
  }
  const progress = spinner();
  progress.start("Creating a free Neon database");
  try {
    const created = await provisionNeonDatabase(project.root, envPath, shared);
    progress.stop(describeNewDatabase(created, cli));
  } catch (error) {
    progress.stop("Neon created no database");
    log.warn(`${error instanceof Error ? error.message : String(error)} Run \`${cli} neon create\` to try again.`);
  }
}

/**
 * Where an app the change adds is, and what is left of one it removes: the files that were never
 * the Starter's, such as its env file, its dependencies, or native projects, stay.
 */
async function reportApps(project: Project, change: Change) {
  const { manifest } = change.target;
  for (const slotId of change.apps) {
    const slot = manifest.slots[slotId]!;
    const stack = manifest.stacks[stackIn(change.target, slotId)];
    if (stack) {
      log.info(`${stack.name} is in ${slot.path}, with its settings in ${slot.env.target}. SETUP.md now has the steps to run and build it.`);
      continue;
    }
    const folder = join(project.root, slot.path);
    const left = (await pathExists(folder)) ? (await readdir(folder)).sort() : [];
    if (!left.length) continue;
    const shown = `${left.slice(0, 4).join(", ")}${left.length > 4 ? ", ..." : ""}`;
    log.info(
      `${slot.path} still holds what was never the Starter's (${shown}): its settings, dependencies, or native projects. Delete the folder once you no longer need them.`,
    );
  }
}

/** What add, remove, or upgrade did: "conflicts" when it wrote conflict markers to resolve. */
export type ChangeOutcome = "unchanged" | "changed" | "conflicts";

export async function changeProject(args: CliArgs): Promise<ChangeOutcome> {
  const command = args.command;
  if (command.name !== "add" && command.name !== "remove" && command.name !== "upgrade") throw new Error("Not a project change.");
  const interactive = Boolean(process.stdin.isTTY) && !args.yes;
  const project = await readProject(process.cwd());
  const upgrading = command.name === "upgrade";
  if (
    upgrading &&
    !args.templateDir &&
    project.starterCommit &&
    (args.ref ? args.ref === project.starterCommit : project.starterCommit === starterPin.starterCommit)
  ) {
    outro(`The project is already on Starter ${project.starterRef}.`);
    return "unchanged";
  }

  if (
    command.name === "add" &&
    command.changes.length > 0 &&
    command.changes.every((c) => c.option && (project.modules[c.module] ?? project.stacks[c.module]) === c.option)
  ) {
    outro("The project already uses that selection; nothing to change.");
    return "unchanged";
  }

  if (
    command.name === "remove" &&
    command.modules.length > 0 &&
    command.modules.every((m) => project.modules[m] === "none")
  ) {
    outro("The project already uses that selection; nothing to change.");
    return "unchanged";
  }

  await assertSafeToChange(project, args, interactive);

  const progress = spinner();
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
    const complete =
      command.name === "upgrade" ? command : await completeCommand(baseManifest, project, command, interactive);
    if (!complete) {
      outro("Cancelled; nothing was changed.");
      return "unchanged";
    }
    const change = await planChange(project, complete, base, baseManifest, target, cli);
    if (!change) {
      outro(upgrading ? `The project is already on Starter ${project.starterRef}.` : "The project already uses that selection; nothing to change.");
      return "unchanged";
    }
    const plan = await planUpdate(project, change.base, change.target);

    if (change.releases) log.info(`Starter releases in this upgrade:\n${change.releases}`);
    log.message(`${change.summary}\n\n${describe(plan) || "No file changes."}`);
    if (args.dryRun) {
      for (const note of change.notes) log.info(note);
      outro("Dry run: nothing was changed. Run again without --dry-run to apply.");
      return "unchanged";
    }

    await applyUpdate(plan);
    log.success(`Updated ${plan.actions.filter((action) => action.kind !== "keep").length} files`);

    // The files are written now, so what is left to resolve is reported even when the install fails.
    let installError: unknown;
    const manifests = await conflictedManifests(project.root);
    if (manifests.length) {
      log.warn(conflictedManifestWarning(manifests, args.install));
    } else if (args.install) {
      const { pnpm, problem } = await detectPnpm();
      if (pnpm) {
        try {
          await installDependencies(project.root, pnpm, plan.lockfile.kind === "install" ? ["--no-frozen-lockfile"] : []);
          log.success("Dependencies updated");
        } catch (error) {
          installError = error;
        }
      } else if (problem) {
        log.warn(`pnpm is installed but did not run, so dependencies were not updated. ${problem} Run \`pnpm install\` once it works.`);
      } else {
        log.warn("pnpm was not found. Run `pnpm install` to update dependencies.");
      }
    } else if (plan.lockfile.kind !== "unchanged") {
      log.info("Run `pnpm install` to update dependencies.");
    }

    report(plan);
    await reportApps(project, change);
    for (const note of change.notes) log.info(note);
    if (installError) {
      const reason = installError instanceof Error ? installError.message : String(installError);
      throw new Error(
        `The files were updated, but \`pnpm install\` did not complete: ${reason}${reason.endsWith(".") ? "" : "."} Fix that, then run \`pnpm install\`.`,
      );
    }
    if (change.target.modules.infra === "neon" && project.modules.infra !== "neon") await addNeonDatabase(project, args, cli);
    outro(
      upgrading
        ? "Review the changes with `git diff`, then run `pnpm db:migrate` for new migrations and your tests."
        : "Review the changes with `git diff`, then run `pnpm check:services` and `pnpm db:migrate` if the change added services or tables.",
    );
    return conflictsOf(plan).length ? "conflicts" : "changed";
  } catch (error) {
    if (spinning) progress.stop("Could not prepare the Starter");
    throw error;
  } finally {
    for (const source of sources) await source.cleanup();
  }
}
