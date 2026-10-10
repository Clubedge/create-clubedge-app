import { parseArgs } from "node:util";

export interface CliArgs {
  projectDirectory?: string;
  ref?: string;
  templateDir?: string;
  install: boolean;
  git: boolean;
  yes: boolean;
  dryRun: boolean;
  help: boolean;
  version: boolean;
}

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
        ref: { type: "string" },
        "template-dir": { type: "string" },
        install: { type: "boolean", default: true },
        git: { type: "boolean", default: true },
        yes: { type: "boolean", short: "y", default: false },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`${message.split("\n")[0]} Run with --help to see available options.`);
  }

  const { values, positionals } = parsed;
  if (positionals.length > 1) throw new UsageError("Only one project directory can be provided.");
  if (values.ref !== undefined && !values.ref.trim()) {
    throw new UsageError("--ref requires a tag, branch, or commit.");
  }
  if (values.ref && values["template-dir"]) {
    throw new UsageError("Use either --ref or --template-dir, not both.");
  }

  return {
    projectDirectory: positionals[0],
    ref: values.ref,
    templateDir: values["template-dir"],
    install: values.install,
    git: values.git,
    yes: values.yes,
    dryRun: values["dry-run"],
    help: values.help,
    version: values.version,
  };
}
