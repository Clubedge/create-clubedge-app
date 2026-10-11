// Reads an existing generated project and renders projects in memory, so commands that change
// a project (add, remove, upgrade) can compare what the CLI generated with what it would now.
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathExists } from "../utils/fs.js";
import { displayNameFromPackageName } from "../utils/names.js";
import type { ProjectIdentity } from "./customize.js";
import type { TemplateManifest } from "./manifest.js";
import type { FileMap } from "./merge.js";
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
  framework: string;
  modules: Record<string, string>;
}

/** Finds the generated project that contains `directory` and reads its provenance. */
export async function readProject(directory: string): Promise<Project> {
  let current = resolve(directory);
  while (true) {
    const manifestPath = join(current, "package.json");
    if (await pathExists(manifestPath)) {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const origin = manifest.clubedge;
      if (origin?.starterRef) {
        if (!origin.framework || !origin.modules) {
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
          framework: origin.framework,
          modules: origin.modules,
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

export interface RenderInput {
  source: Pick<TemplateSource, "root" | "files" | "repository" | "ref" | "commit">;
  manifest: TemplateManifest;
  identity: ProjectIdentity;
  framework: string;
  modules: Record<string, string>;
  cliVersion: string;
}

export interface RenderedProject {
  files: FileMap;
  /** The environment example and the local env file the CLI creates from it. */
  envFile: { from: string; to: string } | null;
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
  return { files, envFile: plan.envFile };
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

