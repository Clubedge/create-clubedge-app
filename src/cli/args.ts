import { parseArgs } from "node:util";

/** What to do: create a project (the default), or change the modules of an existing one. */
export type Command =
  | { name: "create" }
  | { name: "add"; module: string; option: string }
  | { name: "remove"; module: string }
  | { name: "upgrade" };

export interface CliArgs {
  command: Command;
  projectDirectory?: string;
  framework?: string;
  /** Module options from --auth, --storage, --cache, and --infra, validated against the Starter later. */
  modules: Record<string, string>;
  ref?: string;
  templateDir?: string;
  install: boolean;
  git: boolean;
  yes: boolean;
  dryRun: boolean;
  /** Change a project even with uncommitted changes or without Git. */
  force: boolean;
  help: boolean;
  version: boolean;
}

/** Module flags the CLI accepts. Which options exist is up to the Starter's manifest. */
export const MODULE_FLAGS = ["auth", "storage", "cache", "infra"] as const;

export class UsageError extends Error {
  override name = "UsageError";
}

export function parseCliArgs(argv: string[]): CliArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      strict: true,
      options: {
        framework: { type: "string" },
        auth: { type: "string" },
        storage: { type: "string" },
        cache: { type: "string" },
        infra: { type: "string" },
        ref: { type: "string" },
        "template-dir": { type: "string" },
        install: { type: "boolean", default: true },
        git: { type: "boolean", default: true },
        yes: { type: "boolean", short: "y", default: false },
        "dry-run": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`${message.split("\n")[0]} Run with --help to see available options.`);
  }

  const { values, positionals } = parsed;
  const command = parseCommand(positionals);
  if (command.name === "create" && positionals.length > 1) {
    throw new UsageError("Only one project directory can be provided.");
  }
  if (command.name !== "create" && (values.framework !== undefined || MODULE_FLAGS.some((id) => values[id]))) {
    throw new UsageError(
      "--framework and module flags only apply when creating a project; use add or remove to change one module.",
    );
  }
  if ((command.name === "add" || command.name === "remove") && values.ref !== undefined) {
    throw new UsageError("--ref only applies when creating or upgrading a project.");
  }
  if (values.framework !== undefined && !values.framework.trim()) {
    throw new UsageError("--framework requires a framework id, such as next or tanstack-start.");
  }
  const modules: Record<string, string> = {};
  for (const module of MODULE_FLAGS) {
    const value = values[module];
    if (value === undefined) continue;
    if (!value.trim()) throw new UsageError(`--${module} requires an option, such as none.`);
    modules[module] = value.trim();
  }
  if (values.ref !== undefined && !values.ref.trim()) {
    throw new UsageError("--ref requires a tag, branch, or commit.");
  }
  if (values.ref && values["template-dir"]) {
    throw new UsageError("Use either --ref or --template-dir, not both.");
  }

  return {
    command,
    projectDirectory: command.name === "create" ? positionals[0] : undefined,
    framework: values.framework?.trim(),
    modules,
    ref: values.ref,
    templateDir: values["template-dir"],
    install: values.install,
    git: values.git,
    yes: values.yes,
    dryRun: values["dry-run"],
    force: values.force,
    help: values.help,
    version: values.version,
  };
}

/**
 * `add <module> <option>`, `remove <module>`, and `upgrade` change an existing project; anything
 * else is the directory of a new project. Create a project literally named "add" with `./add`.
 */
function parseCommand(positionals: string[]): Command {
  const [name, module, option, ...extra] = positionals;
  if (name === "add") {
    if (!module || !option || extra.length) {
      throw new UsageError("Usage: add <module> <option>, for example: add cache redis");
    }
    return { name, module, option };
  }
  if (name === "remove") {
    if (!module || option !== undefined) {
      throw new UsageError("Usage: remove <module>, for example: remove storage");
    }
    return { name, module };
  }
  if (name === "upgrade") {
    if (module !== undefined) throw new UsageError("Usage: upgrade [--ref <tag>], for example: upgrade --ref v0.8.0");
    return { name };
  }
  return { name: "create" };
}
