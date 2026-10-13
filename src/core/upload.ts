import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

/*
 * Which files of a project leave the machine when `try` uploads it: what Git would commit, never
 * an env file other than an example, and never installed or built output.
 */

const skippedDirectories = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".output",
  ".vinxi",
  ".tanstack",
  ".vercel",
  ".netlify",
  ".data",
  "dist",
  "coverage",
  "playwright-report",
  "test-results",
]);

/** Whether a project-relative path (forward slashes) may be uploaded. */
export function isUploadable(path: string): boolean {
  const segments = path.split("/");
  if (segments.some((segment) => skippedDirectories.has(segment))) return false;
  const name = segments.at(-1) ?? "";
  // .env, .env.local, .env.production... hold secrets; .env.example only names the variables.
  if (/^\.env(\.|$)/.test(name) && !name.endsWith(".example")) return false;
  return name !== ".DS_Store";
}

async function walk(root: string, directory = ""): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) paths.push(...(await walk(root, path)));
    } else if (entry.isFile()) {
      paths.push(path);
    }
  }
  return paths;
}

/** Whether `root` or a folder above it is a Git repository (a .git directory, or a .git file in a worktree). */
async function insideGit(root: string): Promise<boolean> {
  for (let current = resolve(root); ; current = dirname(current)) {
    try {
      await stat(join(current, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(current) === current) return false;
  }
}

/**
 * The project's files to upload. In a Git repository: tracked files plus untracked ones that are
 * not ignored, so .gitignore decides as it does for a commit. Elsewhere: every file outside the
 * skipped directories. Either way, isUploadable has the last word.
 */
export async function uploadableFiles(root: string): Promise<string[]> {
  let paths: string[];
  try {
    // git runs without a shell (it is an executable on every platform), with room for large repositories.
    const { stdout } = await promisify(execFile)("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    paths = [...new Set(stdout.split("\0").filter(Boolean))];
  } catch (error) {
    // Inside a repository, only Git knows what .gitignore keeps out; walking instead could upload
    // ignored files. So fall back only where there is no repository at all.
    if (await insideGit(root)) {
      const reason = error instanceof Error ? (error.message.split(/\r?\n/)[0] ?? error.message) : String(error);
      throw new Error(`Could not list the project's files with Git, so nothing was uploaded: ${reason}`);
    }
    paths = await walk(root);
  }
  return paths.filter(isUploadable).sort();
}
