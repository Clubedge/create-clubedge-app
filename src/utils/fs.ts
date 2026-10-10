import { access, copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { runCapture } from "./process.js";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * npm drops `.gitignore` and `.npmrc` from published tarballs, so the bundled template stores
 * them under these names and the CLI restores them when copying.
 */
export const packedFileNames: Record<string, string> = {
  ".gitignore": "_gitignore",
  ".npmrc": "_npmrc",
};

export function toPackedPath(path: string): string {
  return mapBasename(path, (name) => packedFileNames[name]);
}

export function fromPackedPath(path: string): string {
  return mapBasename(path, (name) =>
    Object.entries(packedFileNames).find(([, packed]) => packed === name)?.[0],
  );
}

function mapBasename(path: string, map: (name: string) => string | undefined): string {
  const parts = path.split("/");
  const last = parts.pop()!;
  return [...parts, map(last) ?? last].join("/");
}

/** Never copied from a local template directory that is not a Git work tree. */
const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".nitro",
  ".output",
  ".tanstack",
  ".turbo",
  ".pnpm-store",
  "node_modules",
  "coverage",
  "dist",
  "playwright-report",
  "test-results",
]);

/** Local environment files hold secrets; only the committed example is part of a template. */
function isLocalSecret(name: string): boolean {
  return /^\.env(\..+)?$/.test(name) && name !== ".env.example";
}

/** True for dependencies, build output, and local secrets, which never belong in a template. */
export function isIgnoredTemplatePath(path: string): boolean {
  const parts = path.split("/");
  return parts.some((part) => ignoredDirectories.has(part)) || isLocalSecret(parts.at(-1)!);
}

/**
 * Lists template files as forward-slash relative paths. Inside a Git work tree this narrows to
 * tracked and unignored files. The ignore rules always apply as well, because the directory may
 * sit inside an unrelated repository (a home directory under version control, for example).
 */
export async function listTemplateFiles(root: string): Promise<string[]> {
  let files: string[];
  try {
    const output = await runCapture("git", ["-C", root, "ls-files", "-co", "--exclude-standard", "-z"]);
    files = output.split("\0").filter(Boolean);
  } catch {
    files = await walk(root, root);
  }
  const kept = await Promise.all(
    files.map(async (file) =>
      !isIgnoredTemplatePath(file) && (await pathExists(join(root, file))) ? file : null,
    ),
  );
  return kept.filter((file): file is string => file !== null).sort();
}

async function walk(root: string, directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) files.push(...(await walk(root, path)));
    } else if (entry.isFile() && !isLocalSecret(entry.name)) {
      files.push(relative(root, path).split(sep).join("/"));
    }
  }
  return files;
}

export async function copyTemplateFiles(
  sourceRoot: string,
  targetRoot: string,
  files: Array<{ from: string; to: string }>,
): Promise<void> {
  for (const { from, to } of files) {
    const target = join(targetRoot, to);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(sourceRoot, from), target);
  }
}

/** Removes everything inside a directory while keeping the directory itself. */
export async function emptyDirectory(directory: string): Promise<void> {
  for (const entry of await readdir(directory)) {
    await rm(join(directory, entry), { recursive: true, force: true });
  }
}
