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
  const output = await runCapture("git", [...gitAuthArgs(), "ls-remote", "--tags", `https://github.com/${repository}.git`]);
  return pickTagCommit(output, tag);
}

/**
 * The token for reading a Starter on GitHub: CLUBEDGE_TEMPLATE_TOKEN for a private template
 * (a fork of the Starter your organization keeps), else GITHUB_TOKEN or GH_TOKEN. The CLI passes
 * CLUBEDGE_TEMPLATE_TOKEN to no command it runs in the project, such as pnpm.
 */
export function templateToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CLUBEDGE_TEMPLATE_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || undefined;
}

/** Git's arguments that send the token to github.com for one command, written nowhere. */
function gitAuthArgs(token = templateToken()): string[] {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${basic}`];
}

/** Whether a repository is the Starter this CLI is pinned to, rather than a template of your own. */
export function isPinnedStarter(repository: string | undefined): boolean {
  return !repository || repository.toLowerCase() === starterPin.starterRepository.toLowerCase();
}

/**
 * The newest published release of a template repository, the default for creating and
 * upgrading from it: the CLI's pin names only its own Starter's release.
 */
export async function latestReleaseTag(repository: string, fetcher: typeof fetch = fetch): Promise<string> {
  const token = templateToken();
  const response = await fetcher(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) {
    throw new Error(
      `${repository} has no published release, or this token cannot read it: pass --ref with one of its tags or branches${token ? "" : ", and CLUBEDGE_TEMPLATE_TOKEN for a private repository"}.`,
    );
  }
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${repository}'s newest release.`);
  const { tag_name: tag } = (await response.json()) as { tag_name?: unknown };
  if (typeof tag !== "string" || !tag) throw new Error(`GitHub named no tag for ${repository}'s newest release.`);
  return tag;
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

/** Resolves a tag, branch, or full commit SHA to a commit with `git ls-remote`. */
export async function resolveRefCommit(repository: string, ref: string): Promise<string | undefined> {
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();
  const output = await runCapture("git", [...gitAuthArgs(), "ls-remote", `https://github.com/${repository}.git`]);
  return pickTagCommit(output, ref) ?? pickBranchCommit(output, ref);
}

/** Picks a branch's commit from `git ls-remote` output. */
export function pickBranchCommit(output: string, branch: string): string | undefined {
  const line = output.split("\n").find((entry) => entry.trim().split(/\s+/)[1] === `refs/heads/${branch}`);
  return line?.trim().split(/\s+/)[0];
}

export async function downloadGitHubTemplate(
  ref: string,
  { repository = starterPin.starterRepository, expectedCommit }: { repository?: string; expectedCommit?: string } = {},
): Promise<TemplateSource> {
  // The commit first, then its files: a tag or branch that moved in between cannot leave the
  // project recording one commit over another's files. The ref stays the recorded name.
  let commit: string | undefined;
  if (expectedCommit) {
    commit = await resolveTagCommit(repository, ref);
    if (commit !== expectedCommit) {
      throw new Error(`Starter tag ${ref} resolved to ${commit ?? "no commit"}, expected ${expectedCommit}.`);
    }
  } else {
    commit = await resolveRefCommit(repository, ref).catch(() => undefined);
  }

  const temporary = await mkdtemp(join(tmpdir(), "create-clubedge-app-"));
  // Windows can briefly lock a folder that was just read (antivirus, indexing). Retry, and never
  // fail a command that already did its work over a leftover folder in the system temp directory.
  const cleanup = () =>
    rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  try {
    const root = join(temporary, "starter");
    await downloadTemplate(`gh:${repository}#${commit ?? ref}`, { dir: root, force: true, auth: templateToken() });
    const files = await listTemplateFiles(root);
    return {
      kind: "github",
      root,
      files: files.map((file) => ({ from: file, to: file })),
      repository,
      ref,
      // Recorded in the project's provenance so later add, remove, and upgrade find this revision.
      commit,
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
  /** A template of your own (owner/name), a fork of the Starter, instead of the pinned Starter. */
  repository?: string;
}

/**
 * Picks where template files come from: a local directory, an explicit ref from GitHub, or
 * the Starter bundled into this package. Without a bundle (a CLI checkout that has not run
 * bundle-template), the pinned release is downloaded and its commit verified.
 */
export async function resolveTemplateSource({ ref, templateDir, repository }: SourceOptions): Promise<TemplateSource> {
  if (templateDir) return readDirectoryTemplate(templateDir);
  // A template of your own has no pin: its newest release, unless a ref is given.
  if (!isPinnedStarter(repository)) {
    return downloadGitHubTemplate(ref ?? (await latestReleaseTag(repository!)), { repository });
  }

  const pinned = !ref || ref === starterPin.starterRef;
  if (!pinned) return downloadGitHubTemplate(ref);

  const bundled = await readBundledTemplate();
  if (bundled && bundled.ref === starterPin.starterRef && bundled.commit === starterPin.starterCommit) {
    return bundled;
  }
  return downloadGitHubTemplate(starterPin.starterRef, { expectedCommit: starterPin.starterCommit });
}
