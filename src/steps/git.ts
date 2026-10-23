import { run } from "../utils/process.js";
import type { StdioOptions } from "node:child_process";

export async function initializeGit(directory: string, stdio?: StdioOptions): Promise<void> {
  try {
    await run("git", ["init", "-b", "main"], directory, stdio);
  } catch {
    // Git before 2.28 has no -b option.
    await run("git", ["init"], directory, stdio);
    await run("git", ["branch", "-M", "main"], directory, stdio);
  }
}
