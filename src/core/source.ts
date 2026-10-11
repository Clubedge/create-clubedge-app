import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadTemplate } from "giget";
import { starterPin } from "../package-info.js";
import { fromPackedPath, listTemplateFiles, pathExists } from "../utils/fs.js";
import { runCapture } from "../utils/process.js";

/** Written by scripts/bundle-template.mjs next to the bundled template. */
export interface TemplateLock {
  repository: string;
  ref: string;
  commit: string;
  files: string[];
}

export interface TemplateSource {
  kind: "bundled" | "directory" | "github";
  root: string;
  /** Source path and destination path for every template file. */
  files: Array<{ from: string; to: string }>;
  repository: string;
  ref: string;
  commit?: string;
  /** Removes temporary downloads. Safe to call more than once. */
  cleanup(): Promise<void>;
}

// dist/core/source.js (or src/core/source.ts in tests) → the package root.
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
export const bundledTemplateDirectory = join(packageRoot, "template");
export const bundledLockFile = join(packageRoot, "template.lock.json");

const noCleanup = async () => {};

export async function readBundledTemplate(
  lockFile = bundledLockFile,
  templateDirectory = bundledTemplateDirectory,
): Promise<TemplateSource | null> {
  if (!(await pathExists(lockFile))) return null;
  const lock = JSON.parse(await readFile(lockFile, "utf8")) as TemplateLock;
  return {
    kind: "bundled",
    root: templateDirectory,
    files: lock.files.map((from) => ({ from, to: fromPackedPath(from) })),
    repository: lock.repository,
    ref: lock.ref,
    commit: lock.commit,
    cleanup: noCleanup,
  };
}

export async function readDirectoryTemplate(directory: string): Promise<TemplateSource> {
  const root = resolve(directory);
  if (!(await pathExists(join(root, "package.json")))) {
    throw new Error(`No Starter found at ${root}: package.json is missing.`);
  }
  const files = await listTemplateFiles(root);
  let commit: string | undefined;
  try {
    commit = await runCapture("git", ["-C", root, "rev-parse", "HEAD"]);
  } catch {
    commit = undefined;
  }
  return {
    kind: "directory",
    root,
    files: files.map((file) => ({ from: file, to: file })),
    repository: starterPin.starterRepository,
    ref: "local",
    commit,
    cleanup: noCleanup,
  };
}

/** Resolves a tag to its commit with `git ls-remote`, following annotated tags. */
export async function resolveTagCommit(repository: string, tag: string): Promise<string | undefined> {
  // List every tag rather than passing a `refs/tags/<tag>^{}` pattern: on Windows the command
  // runs through cmd.exe, which strips `^`, so the peeled ref would never match.
  const output = await runCapture("git", ["ls-remote", "--tags", `https://github.com/${repository}.git`]);
  return pickTagCommit(output, tag);
}

/** Picks a tag's commit from `git ls-remote` output, preferring the peeled ref of an annotated tag. */
export function pickTagCommit(output: string, tag: string): string | undefined {
  const refs = new Map(
    output
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .map(([id, ref]) => [ref, id] as const),
  );
  return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
}

export async function downloadGitHubTemplate(
  ref: string,
  { repository = starterPin.starterRepository, expectedCommit }: { repository?: string; expectedCommit?: string } = {},
): Promise<TemplateSource> {
  if (expectedCommit) {
    const commit = await resolveTagCommit(repository, ref);
    if (commit !== expectedCommit) {
      throw new Error(`Starter tag ${ref} resolved to ${commit ?? "no commit"}, expected ${expectedCommit}.`);
    }
  }

  const temporary = await mkdtemp(join(tmpdir(), "create-clubedge-app-"));
  const cleanup = () => rm(temporary, { recursive: true, force: true });
  try {
    const root = join(temporary, "starter");
    await downloadTemplate(`gh:${repository}#${ref}`, { dir: root, force: true });
    const files = await listTemplateFiles(root);
    return {
      kind: "github",
      root,
      files: files.map((file) => ({ from: file, to: file })),
      repository,
      ref,
      commit: expectedCommit,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export interface SourceOptions {
  ref?: string;
  templateDir?: string;
}

/**
 * Picks where template files come from: a local directory, an explicit ref from GitHub, or
 * the Starter bundled into this package. Without a bundle (a CLI checkout that has not run
 * bundle-template), the pinned release is downloaded and its commit verified.
 */
export async function resolveTemplateSource({ ref, templateDir }: SourceOptions): Promise<TemplateSource> {
  if (templateDir) return readDirectoryTemplate(templateDir);

  const pinned = !ref || ref === starterPin.starterRef;
  if (!pinned) return downloadGitHubTemplate(ref);

  const bundled = await readBundledTemplate();
  if (bundled && bundled.ref === starterPin.starterRef && bundled.commit === starterPin.starterCommit) {
    return bundled;
  }
  return downloadGitHubTemplate(starterPin.starterRef, { expectedCommit: starterPin.starterCommit });
}
