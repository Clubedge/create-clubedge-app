import { run } from "../utils/process.js";

export async function initializeGit(directory: string): Promise<void> {
  try {
    await run("git", ["init", "-b", "main"], directory);
  } catch {
    // Git before 2.28 has no -b option.
    await run("git", ["init"], directory);
    await run("git", ["branch", "-M", "main"], directory);
  }
}
