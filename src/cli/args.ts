import { parseArgs } from "node:util";

/** What to do: create a project (the default), or change the modules of an existing one. */
export type Command =
  | { name: "create" }
  /** Without a module or option, an interactive run asks for them. */
  | { name: "add"; module?: string; option?: string }
  | { name: "remove"; module?: string }
  | { name: "upgrade" };

export interface CliArgs {
  command: Command;
  projectDirectory?: string;
  framework?: string;
  /**
   * Module options from flags such as --auth none. Any flag that is not one of the CLI's own
   * options names a module; the Starter's manifest validates modules and options later.
   */
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

export class UsageError extends Error {
  override name = "UsageError";
}

/** The CLI's own long options; every other --name value flag selects a module option. */
const OPTIONS = {
  framework: { type: "string" },
  ref: { type: "string" },
  "template-dir": { type: "string" },
  install: { type: "boolean", default: true },
  git: { type: "boolean", default: true },
  yes: { type: "boolean", short: "y", default: false },
  "dry-run": { type: "boolean", default: false },
  force: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
} as const;

const isOwnOption = (name: string) =>
  name in OPTIONS || (name.startsWith("no-") && OPTIONS[name.slice(3) as keyof typeof OPTIONS]?.type === "boolean");

/**
 * Takes module flags (`--email smtp` or `--email=smtp`) out of the arguments, leaving the CLI's
 * own options for the strict parser. A flag that is neither needs a value, so a stray unknown
 * flag such as --verbose is still reported.
 */
function extractModuleFlags(argv: string[]) {
  const rest: string[] = [];
  const modules: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    if (argument === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    const match = /^--([^=]+)(?:=(.*))?$/.exec(argument);
    if (!match || isOwnOption(match[1]!)) {
      rest.push(argument);
      // A string option's value is never a flag of its own.
      if (match && match[2] === undefined && OPTIONS[match[1] as keyof typeof OPTIONS]?.type === "string") {
        if (argv[i + 1] !== undefined) rest.push(argv[++i]!);
      }
      continue;
    }
    const [, name, inline] = match;
    if (!/^[a-z][a-z0-9-]*$/.test(name!)) throw new UsageError(`Unknown option --${name}. Run with --help to see available options.`);
    const next = argv[i + 1];
    const value = inline ?? (next !== undefined && !next.startsWith("-") ? argv[++i] : undefined);
    if (value === undefined) {
      throw new UsageError(
        `Unknown option --${name}. Module flags take an option, such as --${name} none. Run with --help to see available options.`,
      );
    }
    if (!value.trim()) throw new UsageError(`--${name} requires an option, such as none.`);
    modules[name!] = value.trim();
  }
  return { rest, modules };
}

export function parseCliArgs(argv: string[]): CliArgs {
  const { rest, modules } = extractModuleFlags(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      allowNegative: true,
      strict: true,
      options: {
        ...OPTIONS,
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
  if (command.name !== "create" && (values.framework !== undefined || Object.keys(modules).length)) {
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
    if (extra.length) throw new UsageError("Usage: add [module] [option], for example: add cache redis");
    return { name, module, option };
  }
  if (name === "remove") {
    if (option !== undefined) throw new UsageError("Usage: remove [module], for example: remove storage");
    return { name, module };
  }
  if (name === "upgrade") {
    if (module !== undefined) throw new UsageError("Usage: upgrade [--ref <tag>], for example: upgrade --ref v0.8.0");
    return { name };
  }
  return { name: "create" };
}
