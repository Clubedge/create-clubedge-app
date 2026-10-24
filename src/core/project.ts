// Reads an existing generated project and renders projects in memory, so commands that change
// a project (add, remove, upgrade) can compare what the CLI generated with what it would now.
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathExists } from "../utils/fs.js";
import { displayNameFromPackageName } from "../utils/names.js";
import { recordedStacks, type ProjectIdentity } from "./customize.js";
import type { TemplateManifest } from "./manifest.js";
import type { ProjectService } from "./manifest.js";
import { countConflicts, INCOMING_DIR, type FileMap } from "./merge.js";
import { createPlan } from "./plan.js";
import type { TemplateSource } from "./source.js";

export class ProjectError extends Error {
  override name = "ProjectError";
}

/** A generated project, with the provenance the CLI recorded in its package.json. */
export interface Project {
  root: string;
  identity: ProjectIdentity;
  cliVersion: string;
  starterRepository: string;
  starterRef: string;
  /** Missing when the project was scaffolded from a local Starter folder outside Git. */
  starterCommit?: string;
  /** The stack per slot, such as `{ framework: "next" }`. */
  stacks: Record<string, string>;
  modules: Record<string, string>;
  services: Record<string, ProjectService>;
}

/** The Starter's version of a file, saved by the last change in the `.clubedge` of a folder above it. */
async function findIncoming(file: string): Promise<string | null> {
  let folder = dirname(file);
  while (true) {
    const incoming = join(folder, INCOMING_DIR, relative(folder, file));
    if (await pathExists(incoming)) return incoming;
    const parent = dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
}

/**
 * Why a package.json does not parse, naming it as seen from `directory`. Most often it is a
 * conflict left by add, remove, or upgrade, which pnpm cannot read either.
 */
async function unreadableManifest(path: string, content: Buffer, directory: string, error: unknown): Promise<ProjectError> {
  const shown = (file: string) => relative(directory, file).split(sep).join("/");
  const conflicts = countConflicts(content);
  if (!conflicts) {
    return new ProjectError(
      `${shown(path)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}. Fix it, then run this again.`,
    );
  }
  const incoming = await findIncoming(path);
  return new ProjectError(
    `${shown(path)} has ${conflicts} unresolved ${conflicts === 1 ? "conflict" : "conflicts"} from an earlier add, remove, or upgrade, ` +
      "marked <<<<<<< yours ... ======= ... >>>>>>> clubedge. While it has the markers, pnpm cannot read it either, so `pnpm install` and `pnpm clubedge` fail too. " +
      "Keep your lines, the Starter's, or a mix, delete the markers, then run this again." +
      (incoming ? `\nThe Starter's version, to compare with yours:\n  git diff --no-index ${shown(path)} ${shown(incoming)}` : ""),
  );
}

/** Finds the generated project that contains `directory` and reads its provenance. */
export async function readProject(directory: string): Promise<Project> {
  const start = resolve(directory);
  let current = start;
  while (true) {
    const manifestPath = join(current, "package.json");
    if (await pathExists(manifestPath)) {
      const content = await readFile(manifestPath);
      let manifest;
      try {
        manifest = JSON.parse(content.toString("utf8"));
      } catch (error) {
        throw await unreadableManifest(manifestPath, content, start, error);
      }
      const origin = manifest.clubedge;
      if (origin?.starterRef) {
        // Projects record the framework only when the Starter offered a choice, but always their modules.
        if (!origin.modules) {
          throw new ProjectError(
            "This project was created before create-clubedge-app 0.5.0 and does not record its modules, so it cannot be changed automatically.",
          );
        }
        return {
          root: current,
          identity: { packageName: manifest.name, displayName: displayNameFromPackageName(manifest.name) },
          cliVersion: origin.cliVersion,
          starterRepository: origin.starterRepository,
          starterRef: origin.starterRef,
          starterCommit: origin.starterCommit,
          stacks: recordedStacks(origin),
          modules: origin.modules,
          services: origin.services && typeof origin.services === "object" ? origin.services : {},
        };
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new ProjectError(
        "No Clubedge project found here. Run this command inside a project created by create-clubedge-app.",
      );
    }
    current = parent;
  }
}

/** An app's environment example and the local env file made from it, relative to the project. */
export interface ProjectEnvFile {
  example: string;
  local: string;
}

/** The web app's: every project has it, with its example at the root. */
const webEnvFile: ProjectEnvFile = { example: ".env.example", local: "apps/web/.env.local" };
const appEnvFile = (app: string): ProjectEnvFile => ({ example: `${app}/.env.example`, local: `${app}/.env.local` });

/** The directory of the project's separate API, or null when the app is full-stack. */
function apiDirectory(project: Pick<Project, "services" | "stacks">): string | null {
  const api = Object.values(project.services).find(({ role }) => role === "api");
  // Projects from Starter 0.22 record the API's stack but no services; the API is in apps/api.
  return api?.app ?? (project.stacks.api ? "apps/api" : null);
}

/** Each app's env files: the web app's, then the API's, which keeps both in its own folder. */
export function projectEnvFiles(project: Pick<Project, "services" | "stacks">): ProjectEnvFile[] {
  const api = apiDirectory(project);
  return [webEnvFile, ...(api ? [appEnvFile(api)] : [])];
}

/**
 * The env file with the database URLs: the API's when the project has one, since the API owns
 * the database (its migrations, its jobs), else the web app's. Matches the plan's databaseEnvFile.
 */
export function databaseEnvFile(project: Pick<Project, "services" | "stacks">): ProjectEnvFile {
  const api = apiDirectory(project);
  return api ? appEnvFile(api) : webEnvFile;
}

export interface RenderInput {
  source: Pick<TemplateSource, "root" | "files" | "repository" | "ref" | "commit">;
  manifest: TemplateManifest;
  identity: ProjectIdentity;
  stacks: Record<string, string>;
  modules: Record<string, string>;
  cliVersion: string;
}

export interface RenderedProject {
  files: FileMap;
  /** Each app's environment example and the local env file the CLI creates from it. */
  envFiles: Array<{ from: string; to: string }>;
}

/** The files the CLI generates for this selection, without writing anything. */
export async function renderProject(input: RenderInput): Promise<RenderedProject> {
  const plan = createPlan({ ...input, targetDirectory: "", git: false, install: false });
  const files: FileMap = new Map();
  for (const { from, to } of plan.files) files.set(to, await readFile(join(input.source.root, from)));
  for (const edit of plan.edits) {
    const content = files.get(edit.path);
    if (content) files.set(edit.path, Buffer.from(edit.apply(content.toString("utf8"))));
  }
  return { files, envFiles: plan.envFiles };
}

/** Reads the project's copies of the given paths; missing files are left out. */
export async function readProjectFiles(root: string, paths: Iterable<string>): Promise<FileMap> {
  const files: FileMap = new Map();
  for (const path of paths) {
    try {
      files.set(path, await readFile(join(root, path)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return files;
}
