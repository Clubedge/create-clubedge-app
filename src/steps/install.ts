import process from "node:process";
import { commandSucceeds, run } from "../utils/process.js";

/** The generated workspace relies on pnpm features (workspace:* and pnpm-workspace.yaml). */
export async function resolvePnpm(): Promise<string[] | null> {
  if (await commandSucceeds("pnpm", ["--version"])) return ["pnpm"];
  if (await commandSucceeds("corepack", ["pnpm", "--version"])) return ["corepack", "pnpm"];
  return null;
}

/** The package manager that launched the CLI, from npm_config_user_agent (e.g. "npm/10.8.2 ..."). */
export function detectLauncher(userAgent = process.env.npm_config_user_agent): string | null {
  const name = userAgent?.split("/")[0];
  return name && ["npm", "pnpm", "yarn", "bun"].includes(name) ? name : null;
}

export async function installDependencies(directory: string, pnpm: string[], args: string[] = []): Promise<void> {
  const [command, ...prefix] = pnpm;
  await run(command!, [...prefix, "install", ...args], directory);
}
