#!/usr/bin/env node

import { cancel, intro, isCancel, outro, spinner, text } from "@clack/prompts";
import { downloadTemplate } from "giget";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const starterRepository = "yassine-ahmed/clubedge-starter";
const defaultRef = "main";
const packageVersion = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;

function showHelp() {
  console.log(`
create-clubedge-app ${packageVersion}

Create a Next.js project from the Clubedge Starter reference repository.

Usage:
  pnpm dlx @clubedge/create-clubedge-app [project-directory] [options]

Options:
  --ref <branch-or-tag>  Starter branch or tag to scaffold (default: ${defaultRef})
  --no-install           Skip dependency installation
  --no-git               Skip Git repository initialization
  -h, --help             Show this help
  -v, --version          Show the CLI version

Examples:
  pnpm dlx @clubedge/create-clubedge-app my-app
  pnpm dlx @clubedge/create-clubedge-app my-app --ref v1.0.0
  pnpm dlx @clubedge/create-clubedge-app my-app --no-install
`);
}

function parseArguments(args) {
  const options = { install: true, git: true, ref: defaultRef, projectDirectory: undefined };

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

async function customizeProject(directory, packageName) {
  const rootManifestPath = join(directory, "package.json");
  const rootManifest = JSON.parse(await readFile(rootManifestPath, "utf8"));
  rootManifest.name = packageName;

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
  await writeFile(readmePath, readme.replace(/^# Clubedge Starter$/m, `# ${displayName}`));

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
  const source = `gh:${starterRepository}#${options.ref}`;
  const downloadSpinner = spinner();
  downloadSpinner.start(`Downloading Clubedge Starter (${options.ref})`);
  try {
    await downloadTemplate(source, { dir: projectDirectory, force: true });
    await customizeProject(projectDirectory, projectName);
    downloadSpinner.stop("Starter files downloaded and configured");
  } catch (error) {
    downloadSpinner.stop("Project scaffold failed");
    throw error;
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
    `Created ${projectName}.\n\nNext steps:\n  cd ${relativeDirectory}\n  pnpm dev\n\nSee SETUP.md for database and provider configuration.`,
  );
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      showHelp();
      return;
    }
    if (options.version) {
      console.log(packageVersion);
      return;
    }

    intro("Create a project with Clubedge Starter");
    await createProject(options);
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export { customizeProject, displayNameFromPackageName, packageNameFromDirectory };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
