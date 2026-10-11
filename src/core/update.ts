// Changes an existing project from one generated state (base) to another (target): different
// modules for add and remove, or a newer Starter for upgrade. The project's own edits survive
// through a three-way merge, see merge.ts.
import { mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { updateEnvFile, type EnvUpdate } from "./env.js";
import type { TemplateManifest } from "./manifest.js";
import { planMerge, sameContent, type MergeAction } from "./merge.js";
import { readProjectFiles, renderProject, type Project } from "./project.js";
import type { TemplateSource } from "./source.js";

const LOCKFILE = "pnpm-lock.yaml";

/** One side of an update: the Starter revision and the selection to render. */
export interface UpdateSide {
  source: Pick<TemplateSource, "root" | "files" | "repository" | "ref" | "commit">;
  manifest: TemplateManifest;
  modules: Record<string, string>;
  cliVersion: string;
}

export interface UpdatePlan {
  project: Project;
  actions: MergeAction[];
  /**
   * "replace": the project's lockfile is still the generated one, so it takes the target's.
   * "install": the project changed its dependencies, so `pnpm install` must reconcile them.
   */
  lockfile: { kind: "unchanged" } | { kind: "replace"; content: Buffer } | { kind: "install" };
  /** The local env file, such as apps/web/.env.local; `update` is null when it does not exist. */
  env: { path: string; update: EnvUpdate | null; changed: boolean } | null;
}

export async function planUpdate(project: Project, base: UpdateSide, target: UpdateSide): Promise<UpdatePlan> {
  const render = (side: UpdateSide) =>
    renderProject({
      source: side.source,
      manifest: side.manifest,
      identity: project.identity,
      framework: project.framework,
      modules: side.modules,
      cliVersion: side.cliVersion,
    });
  const before = await render(base);
  const after = await render(target);

  // The lockfile and the local env file are handled on their own below.
  const envFile = after.envFile ?? before.envFile;
  const special = [LOCKFILE, ...(envFile ? [envFile.to] : [])];
  const strip = (files: Map<string, Buffer>) =>
    new Map([...files].filter(([path]) => !special.includes(path)));
  const baseFiles = strip(before.files);
  const targetFiles = strip(after.files);
  const current = await readProjectFiles(project.root, [
    ...new Set([...baseFiles.keys(), ...targetFiles.keys(), ...special]),
  ]);

  const actions = planMerge(baseFiles, targetFiles, current);

  let lockfile: UpdatePlan["lockfile"] = { kind: "unchanged" };
  const baseLock = before.files.get(LOCKFILE);
  const targetLock = after.files.get(LOCKFILE);
  const currentLock = current.get(LOCKFILE);
  if (targetLock && !(baseLock && sameContent(baseLock, targetLock))) {
    lockfile =
      baseLock && currentLock && sameContent(currentLock, baseLock)
        ? { kind: "replace", content: targetLock }
        : { kind: "install" };
  }

  let env: UpdatePlan["env"] = null;
  if (envFile) {
    const text = (files: Map<string, Buffer>) => files.get(envFile.from)?.toString("utf8") ?? "";
    const baseExample = text(before.files);
    const targetExample = text(after.files);
    const local = current.get(envFile.to)?.toString("utf8");
    const update = local === undefined ? null : updateEnvFile(local, baseExample, targetExample);
    env = { path: envFile.to, update, changed: update !== null && update.text !== local };
  }

  return { project, actions, lockfile, env };
}

/** Removes empty folders left behind by deleted files, up to the project root. */
async function removeEmptyFolders(root: string, path: string) {
  let folder = dirname(join(root, path));
  while (folder.length > root.length) {
    try {
      if ((await readdir(folder)).length > 0) return;
      await rmdir(folder);
    } catch {
      return;
    }
    folder = dirname(folder);
  }
}

export async function applyUpdate(plan: UpdatePlan): Promise<void> {
  const { root } = plan.project;
  for (const action of plan.actions) {
    const path = join(root, action.path);
    if (action.kind === "delete") {
      await rm(path, { force: true });
      await removeEmptyFolders(root, action.path);
    } else if (action.kind !== "keep") {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, action.content);
    }
  }
  if (plan.lockfile.kind === "replace") await writeFile(join(root, LOCKFILE), plan.lockfile.content);
  if (plan.env?.update && plan.env.changed) await writeFile(join(root, plan.env.path), plan.env.update.text);
}
