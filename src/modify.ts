// `add`, `remove`, and `upgrade` change an existing project. The project's recorded Starter
// commit and modules (base) and the new state (target: other modules, or a newer Starter) are
// rendered in memory, and the difference is merged into the project (see core/update.ts).
import { confirm, isCancel, log, outro, spinner } from "@clack/prompts";
import process from "node:process";
import { UsageError, type CliArgs } from "./cli/args.js";
import { dim } from "./cli/ui.js";
import { readTemplateManifest, type TemplateManifest } from "./core/manifest.js";
import type { MergeAction } from "./core/merge.js";
import { selectModules } from "./core/plan.js";
import { readProject, type Project } from "./core/project.js";
import {
  downloadGitHubTemplate,
  readDirectoryTemplate,
  resolveTemplateSource,
  type TemplateSource,
} from "./core/source.js";
import { applyUpdate, planUpdate, type UpdatePlan, type UpdateSide } from "./core/update.js";
import { cliVersion, starterPin } from "./package-info.js";
import { installDependencies, resolvePnpm } from "./steps/install.js";
import { commandSucceeds, runCapture } from "./utils/process.js";

type ChangeCommand = Exclude<CliArgs["command"], { name: "create" }>;

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

/** The selection after add or remove, validated against the Starter's manifest. */
function changedModules(manifest: TemplateManifest, project: Project, command: Exclude<ChangeCommand, { name: "upgrade" }>) {
  const module = manifest.modules[command.module];
  if (!module) {
    throw new UsageError(`Unknown module "${command.module}". Choose one of: ${Object.keys(manifest.modules).join(", ")}.`);
  }
  let option: string;
  if (command.name === "add") {
    option = command.option;
    if (!module.options[option]) {
      throw new UsageError(`Unknown ${command.module} option "${option}". Choose one of: ${Object.keys(module.options).join(", ")}.`);
    }
  } else {
    if (!module.options.none) {
      const others = Object.keys(module.options).filter((id) => id !== project.modules[command.module]);
      throw new UsageError(
        `${module.name} cannot be removed. Switch it instead, for example: add ${command.module} ${others[0] ?? module.default}`,
      );
    }
    option = "none";
  }
  // Validates requirements between modules, such as Supabase Storage needing Supabase Auth.
  return selectModules(manifest, { ...project.modules, [command.module]: option });
}

/**
 * The project's selection in a newer Starter. Modules the project predates get their "none"
 * option where there is one, so an upgrade never adds a service on its own.
 */
export function upgradedModules(manifest: TemplateManifest, project: Project) {
  const requested: Record<string, string> = {};
  const introduced: string[] = [];
  for (const [id, module] of Object.entries(manifest.modules)) {
    const recorded = project.modules[id];
    if (recorded === undefined) {
      requested[id] = module.options.none ? "none" : module.default;
      introduced.push(id);
    } else if (!module.options[recorded]) {
      throw new UsageError(
        `The new Starter no longer offers ${module.name} "${recorded}". Choose one of: ${Object.keys(module.options).join(", ")}, with add ${id} <option>, before upgrading.`,
      );
    } else {
      requested[id] = recorded;
    }
  }
  const dropped = Object.keys(project.modules).filter((id) => !manifest.modules[id]);
  return { modules: selectModules(manifest, requested), introduced, dropped };
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
  const env = plan.env?.update;
  if (plan.env && env && plan.env.changed) {
    const parts = [
      env.added.length ? `adds ${env.added.join(", ")}` : "",
      env.updated.length ? `updates ${env.updated.join(", ")}` : "",
      env.removed.length ? `removes ${env.removed.join(", ")}` : "",
    ].filter(Boolean);
    lines.push(`${"update".padEnd(8)} ${plan.env.path} ${dim(`(${parts.join("; ")})`)}`);
  }
  return lines.join("\n");
}

function report(plan: UpdatePlan) {
  const conflicts = plan.actions.filter((action) => action.kind === "conflict");
  const kept = plan.actions.filter((action): action is Extract<MergeAction, { kind: "keep" }> => action.kind === "keep");
  if (conflicts.length) {
    log.warn(
      `Resolve the conflict markers (<<<<<<< yours / >>>>>>> clubedge) in:\n${conflicts.map((action) => `  ${action.path}`).join("\n")}`,
    );
  }
  if (kept.length) {
    log.info(`Check these files by hand:\n${kept.map((action) => `  ${action.path}: ${action.reason}`).join("\n")}`);
  }
  if (plan.env && !plan.env.update) {
    log.info(`${plan.env.path} does not exist yet; create it from the example file.`);
  }
  const env = plan.env?.update;
  if (plan.env && env?.customized.length) {
    log.info(
      `You set your own ${env.customized.join(", ")} in ${plan.env.path}; the example's value changed, so check whether yours still fits.`,
    );
  }
  if (plan.env && env?.unused.length) {
    log.info(`The project no longer uses ${env.unused.join(", ")}, which you set in ${plan.env.path}. Remove them when you no longer need them.`);
  }
}

interface Change {
  base: UpdateSide;
  target: UpdateSide;
  /** One line describing the change, such as "Starter v0.6.0 -> v0.7.0". */
  summary: string;
  notes: string[];
}

/** Works out what the command changes; resolves null when the project is already there. */
async function planChange(
  project: Project,
  command: ChangeCommand,
  base: TemplateSource,
  target: TemplateSource | null,
): Promise<Change | null> {
  const baseManifest = await readTemplateManifest(base.root);
  const baseSide = { source: asRecorded(base, project), manifest: baseManifest, modules: project.modules, cliVersion: project.cliVersion };

  if (command.name !== "upgrade") {
    const modules = changedModules(baseManifest, project, command);
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
  const { modules, introduced, dropped } = upgradedModules(targetManifest, project);
  const notes = [
    ...introduced.map((id) => {
      const module = targetManifest.modules[id]!;
      return `Starter ${target.ref} adds ${module.name}; the project uses "${modules[id]}". Choose another option with: add ${id} <option>`;
    }),
    ...dropped.map((id) => `Starter ${target.ref} no longer has the ${id} module; its files are merged away like any other change.`),
  ];
  if (/^v\d/.test(target.ref)) {
    notes.push(`Release notes: https://github.com/${target.repository}/releases/tag/${target.ref}`);
  }
  return {
    base: baseSide,
    target: { source: target, manifest: targetManifest, modules, cliVersion },
    summary: `Starter ${project.starterRef} -> ${target.ref}`,
    notes,
  };
}

export async function changeProject(args: CliArgs): Promise<void> {
  const command = args.command;
  if (command.name === "create") throw new Error("Not a project change.");
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

    const change = await planChange(project, command, base, target);
    spinning = false;
    if (!change) {
      progress.stop("Starter ready");
      outro(upgrading ? `The project is already on Starter ${project.starterRef}.` : "The project already uses that selection; nothing to change.");
      return;
    }
    progress.stop("Starter ready");
    const plan = await planUpdate(project, change.base, change.target);

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
