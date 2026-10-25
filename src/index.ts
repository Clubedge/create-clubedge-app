import { cancel, confirm, intro, isCancel, log, outro, select, spinner, text } from "@clack/prompts";
import { readFile, rm } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import process from "node:process";
import { parseCliArgs, UsageError, type CliArgs } from "./cli/args.js";
import { dim, helpText, showBanner } from "./cli/ui.js";
import { assertTargetIsUsable, executePlan } from "./core/execute.js";
import { readTemplateManifest, type TemplateManifest } from "./core/manifest.js";
import { createPlan, describePlan, listNames, moduleChoices, type ScaffoldPlan, NO_STACK, selectStacks, slotChoices, splitSelection } from "./core/plan.js";
import { readBundledTemplate, resolveTemplateSource } from "./core/source.js";
import { cliUrl, cliVersion, siteUrl, starterPin } from "./package-info.js";
import { runDoctor, showStatus } from "./inspect.js";
import { changeProject } from "./modify.js";
import { deployProject } from "./deploy.js";
import { tryOnRailway } from "./try.js";
import { describeNewDatabase, neonCommand, provisionNeonDatabase } from "./neon.js";
import { initializeGit } from "./steps/git.js";
import { detectLauncher, detectPnpm, installDependencies } from "./steps/install.js";
import { applyPlugins, type PluginContext } from "./steps/plugin.js";
import { commandSucceeds, run } from "./utils/process.js";
import { displayNameFromPackageName, isReservedDeviceName, packageNameFromDirectory } from "./utils/names.js";

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
    validate: (input) => {
      const trimmed = input?.trim();
      if (!trimmed) return "Enter a project directory name.";
      if (isReservedDeviceName(basename(trimmed))) {
        return `"${basename(trimmed)}" is a reserved device name on Windows. Choose another directory name.`;
      }
      return undefined;
    },
  });
  if (isCancel(value)) {
    cancel("Operation cancelled.");
    process.exit(0);
  }
  return value;
}

/**
 * The stack per slot, from flags (--framework, --api), prompts for slots that offer a choice,
 * or the defaults. Only stacks that fit the earlier answers are offered. Returns null when a
 * prompt is cancelled.
 */
async function chooseStacks(
  manifest: TemplateManifest,
  requested: Record<string, string>,
  interactive: boolean,
): Promise<Record<string, string> | null> {
  if (!interactive) return selectStacks(manifest, requested);
  const chosen = { ...requested };
  for (const [slotId, slot] of Object.entries(manifest.slots)) {
    if (chosen[slotId] !== undefined) continue;
    const choices = slotChoices(manifest, slotId, chosen);
    if (choices.length < 2) {
      if (choices[0] !== undefined) chosen[slotId] = choices[0];
      continue;
    }
    const preferred = slot.default ?? NO_STACK;
    const value = await select({
      message: slot.question,
      initialValue: choices.includes(preferred) ? preferred : choices[0]!,
      options: choices.map((id) => ({
        value: id,
        label: manifest.stacks[id]?.name ?? "None",
        ...(id === preferred ? { hint: "default" } : {}),
      })),
    });
    if (isCancel(value)) return null;
    chosen[slotId] = value;
  }
  return selectStacks(manifest, chosen);
}

/**
 * Module options from flags, plus prompts for the rest when the visitor wants to customize.
 * Only options the selected stacks implement, and whose requirements earlier answers meet, are
 * offered. Returns null when a prompt is cancelled.
 */
async function chooseModules(
  manifest: TemplateManifest,
  stacks: Record<string, string>,
  requested: Record<string, string>,
  interactive: boolean,
): Promise<Record<string, string> | null> {
  // Modules with a choice for these apps: a module only a mobile app uses has one for a website.
  const unasked = Object.keys(manifest.modules).filter(
    (id) => requested[id] === undefined && moduleChoices(manifest, stacks, id, requested).length > 1,
  );
  if (!interactive || unasked.length === 0) return requested;

  const customize = await confirm({
    message: `Customize the included services (${unasked.map((id) => manifest.modules[id]!.name.toLowerCase()).join(", ")})?`,
    initialValue: false,
  });
  if (isCancel(customize)) return null;
  if (!customize) return requested;

  const chosen = { ...requested };
  for (const [id, module] of Object.entries(manifest.modules)) {
    if (chosen[id] !== undefined) continue;
    const implemented = moduleChoices(manifest, stacks, id, chosen);
    const available = Object.entries(module.options).filter(([optionId, option]) =>
      implemented.includes(optionId) &&
      Object.entries(option.requires).every(([other, allowed]) => {
        const value = chosen[other] ?? requested[other];
        // Modules answered later are checked when the plan is created.
        return value === undefined || allowed.includes(value);
      }),
    );
    // With one option left, there is nothing to ask. It is still the answer: later modules'
    // requirements check it, and the plan takes it rather than the default.
    if (available.length < 2) {
      if (available[0] !== undefined) chosen[id] = available[0][0];
      continue;
    }
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

/**
 * Installs the dependencies of apps with their own tools, such as uv for a Python API. A
 * missing tool is reported with where to get it; the project is already complete without it.
 */
async function installToolchains(root: string, toolchains: ScaffoldPlan["toolchains"]): Promise<void> {
  for (const { directory, app, toolchain } of toolchains) {
    const [check, ...checkArgs] = toolchain.check;
    const [command, ...args] = toolchain.install;
    const retry = `\`${toolchain.install.join(" ")}\` in ${directory}`;
    if (!(await commandSucceeds(check!, checkArgs))) {
      log.warn(`${toolchain.name} was not found, so the ${app} app's dependencies were not installed. Get it from ${toolchain.url}, then run ${retry}.`);
      continue;
    }
    try {
      await run(command!, args, join(root, directory));
      log.success(`${app} dependencies installed with ${toolchain.name}`);
    } catch (error) {
      log.error(`The ${app} app's dependencies did not install. ${error instanceof Error ? error.message : ""} Run ${retry} to retry.`);
    }
  }
}

async function createProject(args: CliArgs): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY) && !args.yes;
  const requested = args.projectDirectory ?? (interactive ? await askProjectDirectory() : "my-app");
  const targetDirectory = resolve(process.cwd(), requested);
  await assertTargetIsUsable(targetDirectory);

  const packageName = packageNameFromDirectory(targetDirectory);
  const identity = { packageName, displayName: displayNameFromPackageName(packageName), version: "0.1.0" };

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
  let neonEnvFile: string | null = null;
  let sharedEnvFiles: string[] = [];
  let toolchains: ScaffoldPlan["toolchains"] = [];
  try {
    const manifest = await readTemplateManifest(source.root);
    progress.stop(`Starter ${source.ref} ready`);
    spinning = null;
    const requested = splitSelection(manifest, args.framework, args.modules);
    const stacks = await chooseStacks(manifest, requested.stacks, interactive);
    if (stacks === null) {
      cancel("Operation cancelled.");
      return;
    }
    const modules = await chooseModules(manifest, stacks, requested.modules, interactive);
    if (modules === null) {
      cancel("Operation cancelled.");
      return;
    }
    const plan = createPlan({
      targetDirectory,
      identity,
      source,
      manifest,
      stacks,
      modules,
      plugins: args.plugins,
      cliVersion,
      git: args.git,
      install: args.install,
    });

    // --infra neon: a free Neon database, its URLs written into the env file of the app that owns
    // the database (the API, when the project has one).
    toolchains = plan.toolchains;
    neonEnvFile = plan.modules.some(({ id, option }) => id === "infra" && option === "neon") && args.neon ? plan.databaseEnvFile : null;
    sharedEnvFiles = plan.envFiles.map(({ to }) => to);
    const pluginContext: PluginContext = {
      stacks,
      modules,
      apps: Object.fromEntries(plan.apps.map(({ slot, name }) => [slot === "framework" ? "web" : slot, `apps/${name}`])),
      starterRef: source.ref,
      cliVersion,
    };

    if (args.dryRun) {
      let pluginLines: string[] = [];
      if (args.plugins.length > 0) {
        const { dryRunLines } = await applyPlugins(args.plugins, targetDirectory, pluginContext, {
          yes: args.yes,
          dryRun: true,
        });
        pluginLines = dryRunLines;
      }
      const lines = [
        ...describePlan(plan),
        ...(neonEnvFile ? [`Create a free Neon database and set its URLs in ${neonEnvFile}`] : []),
        ...pluginLines,
      ];
      log.message(lines.map((line) => `• ${line}`).join("\n"));
      outro("Dry run: nothing was written. Run again without --dry-run to create the project.");
      return;
    }

    spinning = "writing";
    progress.start(`Writing ${plan.files.length} files`);
    await executePlan(plan, source);
    progress.stop(`Created ${identity.packageName} with ${listNames(plan.apps.map(({ name }) => name))} from Starter ${source.ref}`);
    spinning = null;

    if (args.plugins.length > 0) {
      spinning = "writing";
      progress.start(`Applying ${args.plugins.length} ${args.plugins.length === 1 ? "plugin" : "plugins"}`);
      try {
        await applyPlugins(args.plugins, targetDirectory, pluginContext, { yes: args.yes });
        progress.stop(`Applied ${args.plugins.length} ${args.plugins.length === 1 ? "plugin" : "plugins"}`);
        spinning = null;
      } catch (error) {
        progress.stop("Plugin application failed; nothing was left behind");
        await rm(targetDirectory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }
  } catch (error) {
    if (spinning === "preparing") progress.stop("Could not read the Starter");
    if (spinning === "writing") progress.stop("Project scaffold failed; nothing was left behind");
    throw error;
  } finally {
    await source.cleanup();
  }

  // The project stays when Neon can't be reached: the database can be created later.
  let migrate = "";
  if (neonEnvFile) {
    progress.start("Creating a free Neon database");
    try {
      const created = await provisionNeonDatabase(targetDirectory, neonEnvFile, sharedEnvFiles);
      progress.stop(describeNewDatabase(created, "pnpm clubedge"));
      migrate = "db:migrate";
    } catch (error) {
      progress.stop("Neon created no database");
      log.warn(
        `${error instanceof Error ? error.message : String(error)} Create one later with \`pnpm clubedge neon create\`, or set DATABASE_URL in ${neonEnvFile} yourself.`,
      );
    }
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
    const { pnpm, problem } = await detectPnpm();
    if (!pnpm) {
      log.warn(
        problem
          ? `pnpm is installed but did not run, so dependencies were not installed. ${problem} Run \`pnpm install\` in the project once it works.`
          : "pnpm was not found. Enable it with `corepack enable`, then run `pnpm install` in the project.",
      );
    } else {
      pnpmCommand = pnpm.join(" ");
      try {
        await installDependencies(targetDirectory, pnpm);
        log.success("Dependencies installed");
        await installToolchains(targetDirectory, toolchains);
      } catch (error) {
        log.error(`Project created; dependency installation did not complete. ${error instanceof Error ? error.message : ""}`);
        log.info(`Run \`${pnpmCommand} install\` in the project to retry.`);
      }
    }
  }

  const directory = relative(process.cwd(), targetDirectory) || ".";
  const scripts = JSON.parse(await readFile(join(targetDirectory, "package.json"), "utf8")).scripts ?? {};
  const later = scripts.clubedge
    ? `Change modules and mobile apps later with \`pnpm clubedge add\` or \`pnpm clubedge remove\`, and get Starter updates with \`pnpm clubedge upgrade\`.\n\n`
    : "";
  outro(
    `Next steps:\n  cd ${directory}\n${migrate ? `  ${pnpmCommand} ${migrate}\n` : ""}  ${pnpmCommand} dev\n\n` +
      `See SETUP.md for database and provider configuration.\n\n` +
      later +
      `${dim("Docs")}     ${cliUrl}\n${dim("Clubedge")} ${siteUrl}`,
  );
}

/** The bundled Starter's manifest, for the help text; null in a checkout without a bundle. */
async function bundledManifest(): Promise<TemplateManifest | null> {
  try {
    const bundled = await readBundledTemplate();
    // A checkout can hold an older bundle; only the pinned release describes what this CLI creates.
    if (!bundled || bundled.commit !== starterPin.starterCommit) return null;
    return await readTemplateManifest(bundled.root);
  } catch {
    return null;
  }
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
      console.log(helpText(await bundledManifest()));
      return;
    }
    assertSupportedNode();
    if (args.command.name === "create") {
      intro("Create a project with Clubedge Starter");
      await createProject(args);
    } else if (args.command.name === "status") {
      intro("Project status");
      await showStatus(args);
    } else if (args.command.name === "doctor") {
      intro("Check this project's setup");
      await runDoctor(args);
    } else if (args.command.name === "deploy") {
      intro("Deploy this project");
      await deployProject(args);
    } else if (args.command.name === "neon") {
      intro("Neon database");
      await neonCommand(args);
    } else if (args.command.name === "try") {
      intro("Try a project on a free Railway VM");
      await tryOnRailway(args);
    } else {
      const intros = {
        add: "Add a module or an app to this project",
        remove: "Remove a module or an app from this project",
        upgrade: "Upgrade this project to a newer Starter",
      };
      intro(intros[args.command.name]);
      // Conflicts exit with 0 unless asked: the Starter's upgrade workflow in existing projects
      // runs the newest CLI under `set -o pipefail`, and would stop before opening its pull request.
      if ((await changeProject(args)) === "conflicts" && args.detailedExitCode) process.exitCode = 2;
    }
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export type { Plugin, PluginApi, PluginContext, PluginManifest, PluginRecord } from "./steps/plugin.js";

