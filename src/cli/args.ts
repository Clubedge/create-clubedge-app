import { parseArgs } from "node:util";

/** A module to add or switch; an interactive run asks for a missing option. */
export interface ModuleChange {
  module: string;
  option?: string;
}

/** What to do: create a project (the default), or change the modules of an existing one. */
export type Command =
  | { name: "create" }
  /** Several changes apply as one; with none, or one without an option, a terminal asks. */
  | { name: "add"; changes: ModuleChange[] }
  | { name: "remove"; modules: string[] }
  | { name: "upgrade" }
  /** Read-only: where the project stands, and whether it can run. */
  | { name: "status" }
  | { name: "doctor" }
  /** Create a project on a temporary Railway VM instead of this machine. */
  | { name: "try" };

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
  /** doctor: also run `pnpm check:services`. */
  services: boolean;
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
  services: { type: "boolean", default: true },
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
  // try creates a project too, on a VM, so it takes the same selection flags as create.
  const creates = command.name === "create" || command.name === "try";
  if (command.name === "create" && positionals.length > 1) {
    throw new UsageError("Only one project directory can be provided.");
  }
  if (!creates && (values.framework !== undefined || Object.keys(modules).length)) {
    throw new UsageError(
      "--framework and module flags only apply when creating a project; use add or remove to change modules.",
    );
  }
  if (!creates && command.name !== "upgrade" && values.ref !== undefined) {
    throw new UsageError("--ref only applies when creating or upgrading a project.");
  }
  if (command.name === "try" && values["template-dir"] !== undefined) {
    throw new UsageError("--template-dir does not apply to try: the VM downloads the Starter itself.");
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
    services: values.services,
    help: values.help,
    version: values.version,
  };
}

function assertDistinct(modules: string[]) {
  const repeated = modules.find((module, index) => modules.indexOf(module) !== index);
  if (repeated) throw new UsageError(`The module "${repeated}" is named more than once.`);
}

/**
 * `add <module> <option>...`, `remove <module>...`, and `upgrade` change an existing project, `status`
 * and `doctor` inspect one, and `try` creates one on a Railway VM; anything else is the directory
 * of a new project. Create a project literally named "add" with `./add`.
 */
function parseCommand(positionals: string[]): Command {
  const [name, ...rest] = positionals;
  const module = rest[0];
  if (name === "add") {
    if (rest.length > 1 && rest.length % 2 === 1) {
      throw new UsageError(
        "Usage: add [module option]..., for example: add cache redis, or add email resend payments stripe",
      );
    }
    const changes: ModuleChange[] =
      rest.length === 1
        ? [{ module: rest[0]! }]
        : Array.from({ length: rest.length / 2 }, (_, i) => ({ module: rest[2 * i]!, option: rest[2 * i + 1]! }));
    assertDistinct(changes.map((change) => change.module));
    return { name, changes };
  }
  if (name === "remove") {
    assertDistinct(rest);
    return { name, modules: rest };
  }
  if (name === "status" || name === "doctor") {
    if (module !== undefined) throw new UsageError(`Usage: ${name}, run inside a project.`);
    return { name };
  }
  if (name === "try") {
    if (module !== undefined) throw new UsageError("Usage: try [--framework <id>] [module flags], for example: try --framework tanstack-start");
    return { name };
  }
  if (name === "upgrade") {
    if (module !== undefined) throw new UsageError("Usage: upgrade [--ref <tag>], for example: upgrade --ref v0.8.0");
    return { name };
  }
  return { name: "create" };
}
