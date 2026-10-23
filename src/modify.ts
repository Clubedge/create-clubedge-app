// `add`, `remove`, and `upgrade` change an existing project. The project's recorded Starter
// commit and modules (base) and the new state (target: other modules, or a newer Starter) are
// rendered in memory, and the difference is merged into the project (see core/update.ts).
import { confirm, isCancel, log, multiselect, outro, select, spinner } from "@clack/prompts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { UsageError, type CliArgs } from "./cli/args.js";
import { dim } from "./cli/ui.js";
import { readTemplateManifest, type TemplateManifest } from "./core/manifest.js";
import { compareVersions } from "./core/health.js";
import { countConflicts, type MergeAction } from "./core/merge.js";
import { describeReleases, fetchReleases, releasesBetween } from "./core/releases.js";
import { moduleChoices, selectModules, selectStacks } from "./core/plan.js";
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
import { installDependencies, resolvePnpm } from "./steps/install.js";
import { commandSucceeds, runCapture } from "./utils/process.js";

type ChangeCommand = Extract<CliArgs["command"], { name: "add" | "remove" | "upgrade" }>;
/** add or remove with every argument known. */
type ModuleCommand =
  | { name: "add"; changes: Array<{ module: string; option: string }> }
  | { name: "remove"; modules: string[] };

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
    moduleChoices(manifest, selectStacks(manifest, project.stacks), moduleId).includes(optionId) &&
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
        ? "Usage: add <module> <option>, for example: add cache redis. Run it in a terminal to choose from a list."
        : "Usage: remove <module>, for example: remove storage. Run it in a terminal to choose from a list.",
    );
  }

  // The modules: named on the command line, or picked from a list (several at once).
  let moduleIds = command.name === "add" ? command.changes.map((change) => change.module) : [];
  if (!moduleIds.length) {
    const choices = Object.entries(manifest.modules).filter(([id, module]) =>
      command.name === "add" ? true : Boolean(module.options.none) && project.modules[id] !== "none",
    );
    if (!choices.length) throw new UsageError("No module can be removed: every removable module is already none.");
    const value = await multiselect({
      message:
        command.name === "add"
          ? "Which modules do you want to add or switch? (space to pick, enter to confirm)"
          : "Which modules do you want to remove? (space to pick, enter to confirm)",
      required: true,
      options: choices.map(([id, module]) => ({
        value: id,
        label: module.name,
        hint: `now: ${module.options[project.modules[id] ?? ""]?.name ?? project.modules[id] ?? "not set"}`,
      })),
    });
    if (isCancel(value)) return null;
    moduleIds = value;
  }
  if (command.name === "remove") return { name: "remove", modules: moduleIds };

  // Then an option for each module that was not given one. They apply together, so options that
  // only work together (Supabase Auth with Supabase Storage) can be picked in one go.
  const changes: Array<{ module: string; option: string }> = [];
  for (const moduleId of moduleIds) {
    const given = command.changes.find((change) => change.module === moduleId)?.option;
    if (given) {
      changes.push({ module: moduleId, option: given });
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
 * The selection after add or remove, validated against the Starter's manifest. Every change
 * applies before requirements are checked, so changes that only work together, such as Supabase
 * Auth with Supabase Storage, can be made in one command.
 */
export function changedModules(manifest: TemplateManifest, project: Project, command: ModuleCommand, cli: string) {
  const changes =
    command.name === "add" ? command.changes : command.modules.map((module) => ({ module, option: "none" }));
  const requested = { ...project.modules };
  for (const { module: id, option } of changes) {
    const module = manifest.modules[id];
    if (!module) {
      throw new UsageError(`Unknown module "${id}". Choose one of: ${Object.keys(manifest.modules).join(", ")}.`);
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
  // Validates requirements between modules, such as Supabase Storage needing Supabase Auth, and
  // that the project's stacks implement the new options.
  return selectModules(manifest, requested, selectStacks(manifest, project.stacks));
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
  for (const { path, update: env, changed } of plan.envs) {
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

function report(plan: UpdatePlan) {
  const conflicts = plan.actions.filter(
    (action): action is Extract<MergeAction, { kind: "conflict" }> => action.kind === "conflict",
  );
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
  for (const { path, update: env } of plan.envs) {
    if (!env) {
      log.info(`${path} does not exist yet; create it from the example file.`);
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
  const baseSide = { source: asRecorded(base, project), manifest: baseManifest, modules: project.modules, cliVersion: project.cliVersion };

  if (command.name !== "upgrade") {
    const modules = changedModules(baseManifest, project, command, cli);
    const changed = Object.keys(modules).filter((id) => modules[id] !== project.modules[id]);
    if (!changed.length) return null;
    return {
      base: baseSide,
      target: { ...baseSide, modules, cliVersion },
      summary: changed.map((id) => `${baseManifest.modules[id]!.name}: ${project.modules[id]} -> ${modules[id]}`).join(", "),
      notes: [],
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
    target: { source: target, manifest: targetManifest, modules, cliVersion },
    summary: `Starter ${project.starterRef} -> ${target.ref}`,
    notes,
    releases,
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

export async function changeProject(args: CliArgs): Promise<void> {
  const command = args.command;
  if (command.name !== "add" && command.name !== "remove" && command.name !== "upgrade") throw new Error("Not a project change.");
  const interactive = Boolean(process.stdin.isTTY) && !args.yes;
  const project = await readProject(process.cwd());
  await assertSafeToChange(project, args, interactive);

  const upgrading = command.name === "upgrade";
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
      return;
    }
    const change = await planChange(project, complete, base, baseManifest, target, cli);
    if (!change) {
      outro(upgrading ? `The project is already on Starter ${project.starterRef}.` : "The project already uses that selection; nothing to change.");
      return;
    }
    const plan = await planUpdate(project, change.base, change.target);

    if (change.releases) log.info(`Starter releases in this upgrade:\n${change.releases}`);
    log.message(`${change.summary}\n\n${describe(plan) || "No file changes."}`);
    if (args.dryRun) {
      for (const note of change.notes) log.info(note);
      outro("Dry run: nothing was changed. Run again without --dry-run to apply.");
      return;
    }

    await applyUpdate(plan);
    log.success(`Updated ${plan.actions.filter((action) => action.kind !== "keep").length} files`);

    if (args.install) {
      const pnpm = await resolvePnpm();
      if (!pnpm) log.warn("pnpm was not found. Run `pnpm install` to update dependencies.");
      else {
        await installDependencies(project.root, pnpm, plan.lockfile.kind === "install" ? ["--no-frozen-lockfile"] : []);
        log.success("Dependencies updated");
      }
    } else if (plan.lockfile.kind !== "unchanged") {
      log.info("Run `pnpm install` to update dependencies.");
    }

    report(plan);
    for (const note of change.notes) log.info(note);
    if (change.target.modules.infra === "neon" && project.modules.infra !== "neon") await addNeonDatabase(project, args, cli);
    outro(
      upgrading
        ? "Review the changes with `git diff`, then run `pnpm db:migrate` for new migrations and your tests."
        : "Review the changes with `git diff`, then run `pnpm check:services` and `pnpm db:migrate` if the change added services or tables.",
    );
  } catch (error) {
    if (spinning) progress.stop("Could not prepare the Starter");
    throw error;
  } finally {
    for (const source of sources) await source.cleanup();
  }
}
