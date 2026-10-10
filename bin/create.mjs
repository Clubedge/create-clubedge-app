#!/usr/bin/env node

import { cancel, intro, isCancel, outro, spinner, text } from "@clack/prompts";
import { downloadTemplate } from "giget";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const starterRepository = "Clubedge/clubedge-starter";
const defaultStarterRef = "v0.1.1";
const defaultStarterCommit = "0be0c18d41f01cd011c576fb65c25711081b8ad4";
const siteUrl = "https://clubedge.live";
const cliUrl = "https://starter.clubedge.live";
const packageVersion = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;

/* ------------------------------------------------------------------ */
/* Branding: big block-letter banner                                   */
/* ------------------------------------------------------------------ */

// Each glyph is 6 rows tall. Rows are padded to a common width when rendered.
const glyphs = {
  C: [" ██████╗", "██╔════╝", "██║     ", "██║     ", "╚██████╗", " ╚═════╝"],
  L: ["██╗     ", "██║     ", "██║     ", "██║     ", "███████╗", "╚══════╝"],
  U: ["██╗   ██╗", "██║   ██║", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  B: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██████╔╝", "╚═════╝ "],
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
  D: ["██████╗ ", "██╔══██╗", "██║  ██║", "██║  ██║", "██████╔╝", "╚═════╝ "],
  G: [" ██████╗ ", "██╔════╝ ", "██║  ███╗", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  S: ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
  T: ["████████╗", "╚══██╔══╝", "   ██║   ", "   ██║   ", "   ██║   ", "   ╚═╝   "],
  A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  R: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██║  ██║", "╚═╝  ╚═╝"],
};

function renderWord(word) {
  const letters = [...word].map((letter) => {
    const rows = glyphs[letter];
    const width = Math.max(...rows.map((row) => row.length));
    return rows.map((row) => row.padEnd(width, " "));
  });
  return letters[0].map((_, rowIndex) => letters.map((letter) => letter[rowIndex]).join(""));
}

const colorEnabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const paint = (rgb, value) => (colorEnabled ? `\x1b[38;2;${rgb.join(";")}m${value}\x1b[0m` : value);
const dim = (value) => (colorEnabled ? `\x1b[2m${value}\x1b[0m` : value);
const bold = (value) => (colorEnabled ? `\x1b[1m${value}\x1b[0m` : value);

// Light violet -> Clubedge brand violet, top to bottom across the banner.
const gradientFrom = [165, 140, 255];
const gradientTo = [91, 61, 245];
const mix = (from, to, t) => from.map((channel, index) => Math.round(channel + (to[index] - channel) * t));

function showBanner() {
  // Stay quiet when output is piped (CI, logs, scripts).
  if (!process.stdout.isTTY) return;

  const columns = process.stdout.columns ?? 80;
  const lines = [...renderWord("CLUBEDGE"), ...renderWord("STARTER")];
  const widest = Math.max(...lines.map((line) => line.length));

  console.log("");
  if (columns >= widest + 2) {
    lines.forEach((line, index) => {
      console.log(paint(mix(gradientFrom, gradientTo, index / (lines.length - 1)), line));
    });
  } else {
    // Narrow terminal: compact wordmark instead of wrapping the big letters.
    console.log(paint(gradientTo, bold("CLUBEDGE STARTER")));
  }
  console.log("");
  console.log(`  ${bold("create-clubedge-app")} ${dim(`v${packageVersion}`)}  ${dim("·")}  ${paint(gradientFrom, cliUrl)}`);
  console.log(`  ${dim("By Clubedge")}  ${dim("·")}  ${paint(gradientFrom, siteUrl)}`);
  console.log("");
}

/* ------------------------------------------------------------------ */

function showHelp() {
  console.log(`
create-clubedge-app ${packageVersion}

Create a Next.js project from the Clubedge Starter reference repository.
This CLI release uses Starter ${defaultStarterRef} by default.
Expected Starter commit: ${defaultStarterCommit}

Usage:
  pnpm dlx @clubedge/create-clubedge-app [project-directory] [options]

Options:
  --ref <ref>            Starter tag, branch, or commit to scaffold (default: ${defaultStarterRef})
  --no-install           Skip dependency installation
  --no-git               Skip Git repository initialization
  --with <pkg@version>   Apply a plugin package after scaffolding (repeatable; exact version required)
  -h, --help             Show this help
  -v, --version          Show the CLI version

Examples:
  pnpm dlx @clubedge/create-clubedge-app my-app
  pnpm dlx @clubedge/create-clubedge-app my-app --ref <starter-tag-or-commit>
  pnpm dlx @clubedge/create-clubedge-app my-app --no-install
  pnpm dlx @clubedge/create-clubedge-app my-app --with @scope/plugin@1.2.3

Release model:
  CLI ${packageVersion} -> Starter ${defaultStarterRef}

Learn more:
  CLI      ${cliUrl}
  Clubedge ${siteUrl}
`);
}

function parseArguments(args) {
  const options = {
    install: true,
    git: true,
    ref: defaultStarterRef,
    projectDirectory: undefined,
    plugins: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--help" || argument === "-h") {
      return { ...options, help: true };
    }
    if (argument === "--version" || argument === "-v") {
      return { ...options, version: true };
    }
    if (argument === "--no-install") {
      options.install = false;
      continue;
    }
    if (argument === "--no-git") {
      options.git = false;
      continue;
    }
    if (argument === "--ref" || argument.startsWith("--ref=")) {
      const value = argument === "--ref" ? args[++index] : argument.slice("--ref=".length);
      if (!value || value.startsWith("-")) {
        throw new Error("--ref requires a branch or tag name.");
      }
      options.ref = value;
      continue;
    }
    if (argument === "--with" || argument.startsWith("--with=")) {
      const value = argument === "--with" ? args[++index] : argument.slice("--with=".length);
      if (!value || value.startsWith("-")) {
        throw new Error("--with requires a plugin package and version, such as @scope/plugin@1.2.3.");
      }
      options.plugins.push(parsePluginSpec(value));
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}. Run with --help to see available options.`);
    }
    if (options.projectDirectory) {
      throw new Error("Only one project directory can be provided.");
    }
    options.projectDirectory = argument;
  }

  return options;
}

/* ------------------------------------------------------------------ */
/* Plugins                                                             */
/* ------------------------------------------------------------------ */

// A plugin is an npm package pinned to an exact version. Ranges and dist-tags are
// rejected so the same command keeps producing the same project.
const pluginSpecPattern =
  /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

function parsePluginSpec(spec) {
  const match = pluginSpecPattern.exec(spec);
  if (!match) {
    throw new Error(
      `Invalid plugin "${spec}". Use an npm package pinned to an exact version, such as @scope/plugin@1.2.3.`,
    );
  }
  return { name: match[1], version: match[2] };
}

// Imports the plugin entry declared in an installed package's manifest:
//   { "clubedge": { "plugin": "./plugin.mjs" } }
// The entry must export an apply() function. Requiring the declaration keeps an
// ordinary package from being run by mistake.
async function loadPluginFromDirectory(packageDirectory) {
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  const entry = manifest.clubedge?.plugin;
  if (typeof entry !== "string" || !entry) {
    throw new Error(
      `${manifest.name} is not a create-clubedge-app plugin: its package.json has no "clubedge.plugin" entry.`,
    );
  }
  const module = await import(pathToFileURL(resolve(packageDirectory, entry)).href);
  const apply = module.apply ?? module.default?.apply ?? module.default;
  if (typeof apply !== "function") {
    throw new Error(`${manifest.name} plugin entry ${entry} does not export an apply() function.`);
  }
  return { name: manifest.name, version: manifest.version, apply };
}

async function installAndApplyPlugin(plugin, context) {
  // Install into a throwaway directory so the plugin never becomes a dependency of
  // the generated project. Lifecycle scripts are skipped.
  const installDirectory = await mkdtemp(join(tmpdir(), "create-clubedge-app-plugin-"));
  try {
    await writeFile(join(installDirectory, "package.json"), '{"private":true}\n');
    await runCapture(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "install",
        `${plugin.name}@${plugin.version}`,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
      ],
      installDirectory,
    );
    const loaded = await loadPluginFromDirectory(join(installDirectory, "node_modules", plugin.name));
    await loaded.apply(context);
    return { name: loaded.name, version: loaded.version };
  } finally {
    await rm(installDirectory, { recursive: true, force: true });
  }
}

async function applyPlugins(directory, plugins, context, applyPlugin = installAndApplyPlugin) {
  if (plugins.length === 0) return;

  const applied = [];
  for (const plugin of plugins) {
    try {
      applied.push(await applyPlugin(plugin, { ...context, directory }));
    } catch (error) {
      throw new Error(
        `Plugin ${plugin.name}@${plugin.version} failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // Re-read the manifest: plugins may have added dependencies or scripts.
  const manifestPath = join(directory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.clubedge = { ...manifest.clubedge, plugins: applied };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/* ------------------------------------------------------------------ */

function isCancelled(value) {
  if (isCancel(value)) {
    cancel("Operation cancelled.");
    process.exit(0);
  }
  return value;
}

function packageNameFromDirectory(directory) {
  return (
    basename(directory)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[._-]+|[._-]+$/g, "") || "my-app"
  );
}

function displayNameFromPackageName(packageName) {
  return packageName
    .split(/[-._]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

async function run(command, args, cwd) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}.`));
    });
  });
}

async function runCapture(command, args, cwd) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise(stdout.trim());
        return;
      }
      rejectPromise(
        new Error(
          `${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}${
            stderr.trim() ? `: ${stderr.trim()}` : "."
          }`,
        ),
      );
    });
  });
}

async function verifyDefaultStarterReference(starterRef) {
  if (starterRef !== defaultStarterRef) {
    return;
  }

  const remote = `https://github.com/${starterRepository}.git`;
  const resolvedReference = await runCapture("git", [
    "ls-remote",
    remote,
    `refs/tags/${starterRef}^{}`,
  ]);
  const resolvedCommit = resolvedReference.split(/\s+/)[0];
  if (resolvedCommit !== defaultStarterCommit) {
    throw new Error(
      `Starter tag ${starterRef} resolved to ${resolvedCommit || "no commit"}, expected ${defaultStarterCommit}.`,
    );
  }
}

async function ensureTargetIsSafe(directory) {
  await mkdir(dirname(directory), { recursive: true });

  try {
    const entries = await readdir(directory);
    if (entries.length > 0) {
      throw new Error(`The target directory is not empty: ${directory}`);
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function customizeProject(
  directory,
  packageName,
  starterRef = defaultStarterRef,
  starterCommit = starterRef === defaultStarterRef ? defaultStarterCommit : undefined,
) {
  const rootManifestPath = join(directory, "package.json");
  const rootManifest = JSON.parse(await readFile(rootManifestPath, "utf8"));
  rootManifest.name = packageName;
  rootManifest.clubedge = {
    cliVersion: packageVersion,
    starterRepository,
    starterRef,
    ...(starterCommit ? { starterCommit } : {}),
  };

  for (const scriptName of ["docker:build", "docker:start"]) {
    if (rootManifest.scripts?.[scriptName]) {
      rootManifest.scripts[scriptName] = rootManifest.scripts[scriptName].replace(
        /clubedge-starter/g,
        packageName,
      );
    }
  }
  await writeFile(rootManifestPath, `${JSON.stringify(rootManifest, null, 2)}\n`);

  const readmePath = join(directory, "README.md");
  const readme = await readFile(readmePath, "utf8");
  const displayName = displayNameFromPackageName(packageName);
  const starterCommitLine = starterCommit ? `\n- Starter commit: \`${starterCommit}\`` : "";
  const customizedReadme = readme
    .replace(/^# Clubedge Starter$/m, `# ${displayName}`)
    .replace(
      /^# (.+)$/m,
      `$&\n\n## Generated from\n\n- Starter repository: \`${starterRepository}\`\n- Starter ref: \`${starterRef}\`${starterCommitLine}\n- CLI version: \`${packageVersion}\``,
    );
  await writeFile(readmePath, customizedReadme);

  const layoutPath = join(directory, "apps", "web", "src", "app", "layout.tsx");
  const layout = await readFile(layoutPath, "utf8");
  const customizedLayout = layout
    .replaceAll('"Clubedge Starter"', JSON.stringify(displayName))
    .replace(`%s \u00b7 Clubedge Starter`, `%s \u00b7 ${displayName}`)
    .replace(
      "A production-minded foundation for Clubedge applications.",
      `${displayName} application foundation.`,
    );
  await writeFile(layoutPath, customizedLayout);

  const appFiles = [
    join(directory, "apps", "web", "src", "app", "page.tsx"),
    join(directory, "apps", "web", "src", "app", "dashboard", "_components", "app-sidebar.tsx"),
    join(directory, "apps", "web", "src", "app", "dashboard", "page.tsx"),
    join(directory, "apps", "web", "src", "app", "login", "page.tsx"),
  ];
  for (const appFile of appFiles) {
    let source;
    try {
      source = await readFile(appFile, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    const customizedSource = source
      .replaceAll("Clubedge Starter", displayName)
      .replaceAll('>Clubedge<', `>${displayName}<`)
      .replaceAll("Starter workspace", "Application workspace");
    await writeFile(appFile, customizedSource);
  }

  const exampleEnvironment = join(directory, ".env.example");
  const localEnvironment = join(directory, "apps", "web", ".env.local");
  await cp(exampleEnvironment, localEnvironment, { errorOnExist: true });
}

async function initializeGit(directory) {
  try {
    await run("git", ["init", "-b", "main"], directory);
  } catch {
    await run("git", ["init"], directory);
    await run("git", ["branch", "-M", "main"], directory);
  }
}

async function createProject(options) {
  let requestedDirectory = options.projectDirectory;
  if (!requestedDirectory) {
    requestedDirectory = isCancelled(
      await text({
        message: "Where should the new project be created?",
        placeholder: "my-app",
        validate(value) {
          if (!value.trim()) return "Enter a project directory name.";
        },
      }),
    );
  }

  const projectDirectory = resolve(process.cwd(), requestedDirectory);
  if (projectDirectory === resolve(dirname(projectDirectory))) {
    throw new Error("Choose a project subdirectory rather than a filesystem root.");
  }

  await ensureTargetIsSafe(projectDirectory);

  const projectName = packageNameFromDirectory(projectDirectory);
  await verifyDefaultStarterReference(options.ref);
  const source = `gh:${starterRepository}#${options.ref}`;
  const downloadSpinner = spinner();
  downloadSpinner.start(`Downloading Clubedge Starter (${options.ref})`);
  try {
    await downloadTemplate(source, { dir: projectDirectory, force: true });
    await customizeProject(projectDirectory, projectName, options.ref);
    downloadSpinner.stop("Starter files downloaded and configured");
  } catch (error) {
    downloadSpinner.stop("Project scaffold failed");
    throw error;
  }

  if (options.plugins.length > 0) {
    const pluginSpinner = spinner();
    const names = options.plugins.map((plugin) => `${plugin.name}@${plugin.version}`).join(", ");
    pluginSpinner.start(`Applying plugins: ${names}`);
    try {
      await applyPlugins(projectDirectory, options.plugins, {
        packageName: projectName,
        displayName: displayNameFromPackageName(projectName),
        starterRef: options.ref,
        cliVersion: packageVersion,
      });
      pluginSpinner.stop(`Plugins applied: ${names}`);
    } catch (error) {
      pluginSpinner.stop("Plugin step failed");
      throw error;
    }
  }

  if (options.git) {
    console.log("\nInitializing Git...");
    await initializeGit(projectDirectory);
    console.log("Git repository initialized on main");
  }

  if (options.install) {
    console.log("\nInstalling dependencies with pnpm...\n");
    try {
      await run("pnpm", ["install"], projectDirectory);
      console.log("\nDependencies installed");
    } catch (error) {
      console.error("\nProject created; dependency installation did not complete.");
      console.error(error instanceof Error ? error.message : error);
      console.error("Install pnpm with Corepack, then run `pnpm install` in the new project.");
    }
  }

  const relativeDirectory = process.cwd() === projectDirectory ? "." : requestedDirectory;
  outro(
    `Created ${projectName}.\n\nNext steps:\n  cd ${relativeDirectory}\n  pnpm dev\n\nSee SETUP.md for database and provider configuration.\n\nDocs: ${cliUrl}\nClubedge: ${siteUrl}`,
  );
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.version) {
      console.log(packageVersion);
      return;
    }

    showBanner();

    if (options.help) {
      showHelp();
      return;
    }

    intro("Create a project with Clubedge Starter");
    await createProject(options);
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export {
  applyPlugins,
  customizeProject,
  displayNameFromPackageName,
  loadPluginFromDirectory,
  packageNameFromDirectory,
  parseArguments,
  parsePluginSpec,
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}