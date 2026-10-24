import { tmpdir } from "node:os";
import process from "node:process";
import type { StdioOptions } from "node:child_process";
import { onPath, run, runCapture, withAbsolutePath } from "../utils/process.js";

export interface PnpmDetection {
  /** The command that runs pnpm, or null when neither pnpm nor corepack runs. */
  pnpm: string[] | null;
  /** How pnpm or corepack failed when it is installed; unset when neither is. */
  problem?: string;
}

/**
 * Finds pnpm, which the generated workspace relies on (workspace:* and pnpm-workspace.yaml), or
 * corepack, which runs the pnpm version the project pins. Both are checked outside the project:
 * they read the package.json of the folder they start in and fail when it does not parse, such as
 * while it has conflict markers, and that is not pnpm missing.
 */
export async function detectPnpm(): Promise<PnpmDetection> {
  let problem: string | undefined;
  for (const pnpm of [["pnpm"], ["corepack", "pnpm"]]) {
    const command = pnpm[0]!;
    try {
      // `corepack --version`, not `corepack pnpm --version`: outside a project, corepack would
      // download its own default pnpm just to answer. PATH's relative folders still mean the
      // folder the CLI runs in, where onPath and the install look.
      await runCapture(command, ["--version"], tmpdir(), withAbsolutePath());
      return { pnpm };
    } catch (error) {
      if (!problem && (await onPath(command))) {
        const reason = error instanceof Error ? error.message : String(error);
        problem = `\`${command} --version\` failed: ${reason}${reason.endsWith(".") ? "" : "."}`;
      }
    }
  }
  return { pnpm: null, problem };
}

/** The command that runs pnpm, or null; detectPnpm also says why an installed one did not run. */
export async function resolvePnpm(): Promise<string[] | null> {
  return (await detectPnpm()).pnpm;
}

/** The package manager that launched the CLI, from npm_config_user_agent (e.g. "npm/10.8.2 ..."). */
export function detectLauncher(userAgent = process.env.npm_config_user_agent): string | null {
  const name = userAgent?.split("/")[0];
  return name && ["npm", "pnpm", "yarn", "bun"].includes(name) ? name : null;
}

export async function installDependencies(
  directory: string,
  pnpm: string[],
  args: string[] = [],
  stdio?: StdioOptions,
): Promise<void> {
  const [command, ...prefix] = pnpm;
  await run(command!, [...prefix, "install", ...args], directory, stdio);
}
