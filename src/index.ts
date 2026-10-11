import { cancel, confirm, intro, isCancel, log, outro, select, spinner, text } from "@clack/prompts";
import { relative, resolve } from "node:path";
import process from "node:process";
import { parseCliArgs, UsageError, type CliArgs } from "./cli/args.js";
import { dim, helpText, showBanner } from "./cli/ui.js";
import { assertTargetIsUsable, executePlan } from "./core/execute.js";
import { readTemplateManifest, type TemplateManifest } from "./core/manifest.js";
import { createPlan, describePlan, selectFramework } from "./core/plan.js";
import { resolveTemplateSource } from "./core/source.js";
import { cliUrl, cliVersion, siteUrl } from "./package-info.js";
import { changeProject } from "./modify.js";
import { initializeGit } from "./steps/git.js";
import { detectLauncher, installDependencies, resolvePnpm } from "./steps/install.js";
import { displayNameFromPackageName, packageNameFromDirectory } from "./utils/names.js";

const minimumNode = [22, 12] as const;

export function assertSupportedNode(version = process.versions.node): void {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major < minimumNode[0] || (major === minimumNode[0] && minor < minimumNode[1])) {
    throw new UsageError(
      `Node.js ${minimumNode.join(".")} or newer is required; this is ${version}.`,
    );
  }
}

async function askProjectDirectory(): Promise<string> {
  const value = await text({
    message: "Where should the new project be created?",
    placeholder: "my-app",
    validate: (input) => (input?.trim() ? undefined : "Enter a project directory name."),
  });
  if (isCancel(value)) {
    cancel("Operation cancelled.");
    process.exit(0);
  }
  return value;
}

/**
 * The framework from --framework, a prompt when the Starter offers several, or the default.
 * Returns null when the prompt is cancelled.
 */
async function chooseFramework(
  manifest: TemplateManifest,
  requested: string | undefined,
  interactive: boolean,
): Promise<string | null> {
  if (requested) return selectFramework(manifest, requested).id;
  const ids = Object.keys(manifest.frameworks);
  if (!interactive || ids.length < 2) return manifest.defaultFramework;

  const value = await select({
    message: "Which framework should the app use?",
    initialValue: manifest.defaultFramework,
    options: ids.map((id) => ({
      value: id,
      label: manifest.frameworks[id]!.name,
      ...(id === manifest.defaultFramework ? { hint: "default" } : {}),
    })),
  });
  return isCancel(value) ? null : value;
}

/**
 * Module options from flags, plus prompts for the rest when the visitor wants to customize.
 * Options whose requirements are not met by earlier answers are not offered. Returns null
 * when a prompt is cancelled.
 */
async function chooseModules(
  manifest: TemplateManifest,
  requested: Record<string, string>,
  interactive: boolean,
): Promise<Record<string, string> | null> {
  const unasked = Object.keys(manifest.modules).filter((id) => requested[id] === undefined);
  if (!interactive || unasked.length === 0) return requested;

  const customize = await confirm({
    message: "Customize the included services (auth, storage, cache, local infrastructure)?",
    initialValue: false,
  });
  if (isCancel(customize)) return null;
  if (!customize) return requested;

  const chosen = { ...requested };
  for (const [id, module] of Object.entries(manifest.modules)) {
    if (chosen[id] !== undefined) continue;
    const available = Object.entries(module.options).filter(([, option]) =>
      Object.entries(option.requires).every(([other, allowed]) => {
        const value = chosen[other] ?? requested[other];
        // Modules answered later are checked when the plan is created.
        return value === undefined || allowed.includes(value);
      }),
    );
    const value = await select({
      message: module.name,
      initialValue: available.some(([optionId]) => optionId === module.default)
        ? module.default
        : available[0]![0],
      options: available.map(([optionId, option]) => ({
        value: optionId,
        label: option.name,
        ...(optionId === module.default ? { hint: "default" } : {}),
      })),
    });
    if (isCancel(value)) return null;
    chosen[id] = value;
  }
  return chosen;
}

async function createProject(args: CliArgs): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY) && !args.yes;
  const requested = args.projectDirectory ?? (interactive ? await askProjectDirectory() : "my-app");
  const targetDirectory = resolve(process.cwd(), requested);
  await assertTargetIsUsable(targetDirectory);

  const packageName = packageNameFromDirectory(targetDirectory);
  const identity = { packageName, displayName: displayNameFromPackageName(packageName) };

  const progress = spinner();
  progress.start("Preparing the Starter");
  const source = await resolveTemplateSource({ ref: args.ref, templateDir: args.templateDir }).catch(
    (error: unknown) => {
      progress.stop("Could not prepare the Starter");
      throw error;
    },
  );

  // The spinner runs while the manifest is read and again while files are written.
  let spinning: "preparing" | "writing" | null = "preparing";
  try {
    const manifest = await readTemplateManifest(source.root);
    progress.stop(`Starter ${source.ref} ready`);
    spinning = null;
    const framework = await chooseFramework(manifest, args.framework, interactive);
    if (framework === null) {
      cancel("Operation cancelled.");
      return;
    }
    const modules = await chooseModules(manifest, args.modules, interactive);
    if (modules === null) {
      cancel("Operation cancelled.");
      return;
    }
    const plan = createPlan({
      targetDirectory,
      identity,
      source,
      manifest,
      framework,
      modules,
      cliVersion,
      git: args.git,
      install: args.install,
    });

    if (args.dryRun) {
      log.message(describePlan(plan).map((line) => `• ${line}`).join("\n"));
      outro("Dry run: nothing was written. Run again without --dry-run to create the project.");
      return;
    }

    spinning = "writing";
    progress.start(`Writing ${plan.files.length} files`);
    await executePlan(plan, source);
    progress.stop(`Created ${identity.packageName} with ${plan.framework.name} from Starter ${source.ref}`);
    spinning = null;
  } catch (error) {
    if (spinning === "preparing") progress.stop("Could not read the Starter");
    if (spinning === "writing") progress.stop("Project scaffold failed; nothing was left behind");
    throw error;
  } finally {
    await source.cleanup();
  }

  if (args.git) {
    await initializeGit(targetDirectory);
    log.success("Git repository initialized on main");
  }

  let pnpmCommand = "pnpm";
  if (args.install) {
    const launcher = detectLauncher();
    if (launcher && launcher !== "pnpm") {
      log.info(`This project is a pnpm workspace, so dependencies are installed with pnpm (not ${launcher}).`);
    }
    const pnpm = await resolvePnpm();
    if (!pnpm) {
      log.warn("pnpm was not found. Enable it with `corepack enable`, then run `pnpm install` in the project.");
    } else {
      pnpmCommand = pnpm.join(" ");
      try {
        await installDependencies(targetDirectory, pnpm);
        log.success("Dependencies installed");
      } catch (error) {
        log.error(`Project created; dependency installation did not complete. ${error instanceof Error ? error.message : ""}`);
        log.info(`Run \`${pnpmCommand} install\` in the project to retry.`);
      }
    }
  }

  const directory = relative(process.cwd(), targetDirectory) || ".";
  outro(
    `Next steps:\n  cd ${directory}\n  ${pnpmCommand} dev\n\n` +
      `See SETUP.md for database and provider configuration.\n\n` +
      `${dim("Docs")}     ${cliUrl}\n${dim("Clubedge")} ${siteUrl}`,
  );
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const args = parseCliArgs(argv);
    if (args.version) {
      console.log(cliVersion);
      return;
    }
    showBanner();
    if (args.help) {
      console.log(helpText());
      return;
    }
    assertSupportedNode();
    if (args.command.name === "create") {
      intro("Create a project with Clubedge Starter");
      await createProject(args);
    } else {
      const intros = {
        add: "Add a module to this project",
        remove: "Remove a module from this project",
        upgrade: "Upgrade this project to a newer Starter",
      };
      intro(intros[args.command.name]);
      await changeProject(args);
    }
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
