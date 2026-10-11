// `add` and `remove`: change one module of an existing project. The project's recorded Starter
// commit is rendered twice, with the current and the new selection, and the difference is
// merged into the project (see core/update.ts).
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
import { applyUpdate, planUpdate, type UpdatePlan } from "./core/update.js";
import { cliVersion, starterPin } from "./package-info.js";
import { installDependencies, resolvePnpm } from "./steps/install.js";
import { commandSucceeds, runCapture } from "./utils/process.js";

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

/** The selection after the command, validated against the Starter's manifest. */
function targetModules(manifest: TemplateManifest, project: Project, command: CliArgs["command"]) {
  if (command.name === "create") throw new Error("Not a module command.");
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
      `You set your own ${env.customized.join(", ")} in ${plan.env.path}; the example's value changed with this selection, so check whether yours still fits.`,
    );
  }
  if (plan.env && env?.unused.length) {
    log.info(`The project no longer uses ${env.unused.join(", ")}, which you set in ${plan.env.path}. Remove them when you no longer need them.`);
  }
}

export async function changeModules(args: CliArgs): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY) && !args.yes;
  const project = await readProject(process.cwd());
  await assertSafeToChange(project, args, interactive);

  const progress = spinner();
  progress.start(`Preparing Starter ${project.starterRef}`);
  let source: TemplateSource;
  try {
    source = await projectSource(project, args.templateDir);
  } catch (error) {
    progress.stop("Could not prepare the Starter");
    throw error;
  }

  try {
    const manifest = await readTemplateManifest(source.root);
    const modules = targetModules(manifest, project, args.command);
    const changed = Object.keys(modules).filter((id) => modules[id] !== project.modules[id]);
    if (!changed.length) {
      progress.stop(`Starter ${project.starterRef} ready`);
      outro("The project already uses that selection; nothing to change.");
      return;
    }
    const plan = await planUpdate(
      project,
      { source, manifest, modules: project.modules, cliVersion: project.cliVersion },
      { source, manifest, modules, cliVersion },
    );
    progress.stop(`Starter ${project.starterRef} ready`);

    const summary = changed
      .map((id) => `${manifest.modules[id]!.name}: ${project.modules[id]} -> ${modules[id]}`)
      .join(", ");
    log.message(`${summary}\n\n${describe(plan) || "No file changes."}`);
    if (args.dryRun) {
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
    outro(`Review the changes with \`git diff\`, then run \`pnpm check:services\` and \`pnpm db:migrate\` if the change added services or tables.`);
  } finally {
    await source.cleanup();
  }
}
