import { realpath } from "node:fs/promises";
import type { StdioOptions } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";
import { executePlan } from "./core/execute.js";
import { readTemplateManifest } from "./core/manifest.js";
import { neonSetupStep } from "./core/neon.js";
import { createPlan, describePlan } from "./core/plan.js";
import { resolveTemplateSource } from "./core/source.js";
import { cliVersion, cliUrl, siteUrl } from "./package-info.js";
import { initializeGit } from "./steps/git.js";
import { detectPnpm, installDependencies } from "./steps/install.js";
import { commandSucceeds, run } from "./utils/process.js";
import { displayNameFromPackageName, packageNameFromDirectory } from "./utils/names.js";

type ProjectOptions = {
  stacks?: Record<string, string>;
  modules?: Record<string, string>;
};

// Keep subprocess output off the MCP JSON-RPC stdout stream, and don't let children read MCP input.
const mcpStdio: StdioOptions = ["ignore", process.stderr, process.stderr];

const selectionSchema = {
  stacks: z.record(z.string(), z.string()).optional().describe("Stack id by slot, such as { framework: 'vite', api: 'hono', shell: 'capacitor' }. Slots left out use their default, and optional slots none; get_starter_capabilities lists every slot and its stacks."),
  modules: z.record(z.string(), z.string()).optional().describe("Module option by module id, such as { auth: 'supabase', storage: 's3' }."),
};

function isWithin(directory: string, candidate: string): boolean {
  const path = relative(directory, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

async function workspaceDestination(directory: string): Promise<string> {
  if (!directory.trim()) throw new Error("Choose a project directory inside the MCP server's working directory.");
  if (isAbsolute(directory)) throw new Error("Use a relative project directory beneath the MCP server's working directory.");

  const workspace = await realpath(process.cwd());
  const target = resolve(workspace, directory);
  if (!isWithin(workspace, target) || target === workspace) {
    throw new Error("The project directory must be a child of the MCP server's working directory.");
  }

  // Resolve the nearest existing ancestor so a symlink inside the workspace cannot redirect
  // project writes to an unrelated directory.
  let ancestor = dirname(target);
  let resolvedAncestor: string | undefined;
  while (resolvedAncestor === undefined) {
    try {
      resolvedAncestor = await realpath(ancestor);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  if (resolvedAncestor === undefined || !isWithin(workspace, resolvedAncestor)) {
    throw new Error("The project directory resolves outside the MCP server's working directory.");
  }

  try {
    const resolvedTarget = await realpath(target);
    if (!isWithin(workspace, resolvedTarget)) {
      throw new Error("The project directory resolves outside the MCP server's working directory.");
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  return target;
}

async function withTemplate<T>(fn: (source: Awaited<ReturnType<typeof resolveTemplateSource>>) => Promise<T>): Promise<T> {
  const source = await resolveTemplateSource({});
  try {
    return await fn(source);
  } finally {
    await source.cleanup();
  }
}

async function planProject(
  source: Awaited<ReturnType<typeof resolveTemplateSource>>,
  options: ProjectOptions,
  directory: string,
  sideEffects: { git?: boolean; install?: boolean } = {},
) {
  const manifest = await readTemplateManifest(source.root);
  return createPlan({
    targetDirectory: directory,
    identity: {
      packageName: packageNameFromDirectory(directory),
      displayName: displayNameFromPackageName(packageNameFromDirectory(directory)),
    },
    source,
    manifest,
    stacks: options.stacks,
    modules: options.modules,
    cliVersion,
    git: sideEffects.git ?? false,
    install: sideEffects.install ?? false,
  });
}

function capabilities(
  manifest: Awaited<ReturnType<typeof readTemplateManifest>>,
  source: Awaited<ReturnType<typeof resolveTemplateSource>>,
) {
  return {
    cliVersion,
    starter: {
      repository: source.repository,
      ref: source.ref,
      commit: source.commit,
      docs: cliUrl,
      website: siteUrl,
    },
    slots: Object.entries(manifest.slots).map(([id, slot]) => ({
      id,
      name: slot.name,
      question: slot.question,
      default: slot.default ?? "none",
      choices: Object.entries(manifest.stacks)
        .filter(([, stack]) => stack.slot === id)
        .map(([stackId, stack]) => ({ id: stackId, name: stack.name, role: stack.role, modules: stack.modules })),
    })),
    modules: Object.entries(manifest.modules).map(([id, module]) => ({
      id,
      name: module.name,
      scope: module.scope,
      default: module.default,
      options: Object.entries(module.options).map(([optionId, option]) => ({
        id: optionId,
        name: option.name,
        requires: option.requires,
      })),
    })),
  };
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function createServer() {
  const server = new McpServer({ name: "clubedge-starter", version: cliVersion });

  server.registerTool(
    "get_starter_capabilities",
    {
      description: "Discover the app slots and their stacks (frameworks, APIs, mobile shells), the modules, defaults, and compatibility choices supported by this CLI's pinned Clubedge Starter release. A stack's role decides what it pairs with: a frontend needs an API, a full-stack framework takes none, and a shell packages a frontend.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => withTemplate(async (source) => result(capabilities(await readTemplateManifest(source.root), source))),
  );

  server.registerTool(
    "validate_project_config",
    {
      description: "Check requested stack and module choices against the pinned Starter. This does not write files.",
      inputSchema: z.object(selectionSchema),
      annotations: { readOnlyHint: true },
    },
    async (options) => withTemplate(async (source) => {
      try {
        const plan = await planProject(source, options, resolve(process.cwd(), ".clubedge-validation"));
        return result({
          valid: true,
          stacks: plan.apps.map(({ slot, id, name }) => ({ slot, id, name })),
          modules: plan.modules.map(({ id, option, optionName }) => ({ id, option, name: optionName })),
        });
      } catch (error) {
        return result({ valid: false, error: error instanceof Error ? error.message : String(error) });
      }
    }),
  );

  server.registerTool(
    "plan_project",
    {
      description: "Preview a complete scaffold plan using the pinned Starter. Validates stack and module compatibility and lists planned files and setup actions without writing to disk.",
      inputSchema: z.object({
        directory: z.string().min(1).describe("Destination path relative to the MCP server's working directory."),
        ...selectionSchema,
        initialize_git: z.boolean().default(false).describe("Include Git initialization in the plan."),
        install_dependencies: z.boolean().default(false).describe("Include dependency installation in the plan."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ directory, initialize_git, install_dependencies, ...options }) => withTemplate(async (source) => {
      try {
        const target = await workspaceDestination(directory);
        const plan = await planProject(source, options, target, {
          git: initialize_git,
          install: install_dependencies,
        });
        return result({
          valid: true,
          directory: target,
          destinationMustBeEmpty: true,
          starterRef: plan.provenance.starterRef,
          starterCommit: plan.provenance.starterCommit,
          stacks: plan.apps.map(({ slot, id, name }) => ({ slot, id, name })),
          modules: plan.modules.map(({ id, option, optionName }) => ({ id, option, name: optionName })),
          fileCount: plan.files.length,
          editCount: plan.edits.length,
          environmentFiles: plan.envFiles.map(({ from, to }) => ({ source: from, destination: to })),
          toolchains: plan.toolchains.map(({ directory: appDirectory, app, toolchain }) => ({
            directory: appDirectory,
            app,
            name: toolchain.name,
            install: toolchain.install,
          })),
          actions: describePlan(plan),
          nextSteps: [neonSetupStep(plan)].filter(Boolean),
        });
      } catch (error) {
        return result({ valid: false, error: error instanceof Error ? error.message : String(error) });
      }
    }),
  );

  server.registerTool(
    "create_project",
    {
      description: "Generate a Clubedge Starter project under the MCP server's working directory. The destination must be empty or absent. Git initialization and dependency installation are opt-in.",
      inputSchema: z.object({
        directory: z.string().min(1).describe("Destination path relative to the MCP server's working directory."),
        ...selectionSchema,
        initialize_git: z.boolean().default(false).describe("Initialize a Git repository after generating files."),
        install_dependencies: z.boolean().default(false).describe("Run pnpm install and declared secondary toolchain installs after generating files."),
      }),
    },
    async ({ directory, initialize_git, install_dependencies, ...options }) => withTemplate(async (source) => {
      const target = await workspaceDestination(directory);
      const plan = await planProject(source, options, target, { git: initialize_git, install: install_dependencies });
      await executePlan(plan, source);

      const warnings: string[] = [];
      // The CLI creates the free Neon database itself; MCP makes no network calls, so it is left to the user.
      const neon = neonSetupStep(plan);
      if (neon) warnings.push(neon);
      if (initialize_git) {
        try {
          await initializeGit(target, mcpStdio);
        } catch (error) {
          warnings.push(`Project created, but Git initialization failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (install_dependencies) {
        const { pnpm, problem } = await detectPnpm();
        if (!pnpm) {
          warnings.push(
            problem
              ? `Project created, but pnpm is installed and did not run. ${problem}`
              : "Project created, but pnpm was not found. Install pnpm and run it in the project directory.",
          );
        } else {
          try {
            await installDependencies(target, pnpm, [], mcpStdio);
            for (const { directory: appDirectory, app, toolchain } of plan.toolchains) {
              const [check, ...checkArgs] = toolchain.check;
              if (!(await commandSucceeds(check!, checkArgs))) {
                warnings.push(`${toolchain.name} is required to install ${app} dependencies: ${toolchain.url}`);
                continue;
              }
              const [command, ...args] = toolchain.install;
              try {
                await run(command!, args, resolve(target, appDirectory), mcpStdio);
              } catch (error) {
                warnings.push(`${app} dependencies did not install: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          } catch (error) {
            warnings.push(`Project created, but dependency installation did not complete: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      return result({
        created: true,
        directory: target,
        starterRef: plan.provenance.starterRef,
        stacks: plan.apps.map(({ slot, id, name }) => ({ slot, id, name })),
        modules: plan.modules.map(({ id, option, optionName }) => ({ id, option, name: optionName })),
        actions: describePlan(plan),
        warnings,
      });
    }),
  );

  return server;
}

serveStdio(createServer);
