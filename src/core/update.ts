// Changes an existing project from one generated state (base) to another (target): different
// modules or apps for add and remove, or a newer Starter for upgrade. The project's own edits
// survive through a three-way merge, see merge.ts.
import { mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { customizeAppManifest } from "./customize.js";
import { updateEnvFile, type EnvUpdate } from "./env.js";
import type { TemplateManifest } from "./manifest.js";
import { INCOMING_DIR, planMerge, sameContent, type MergeAction } from "./merge.js";
import { readProjectFiles, renderProject, type Project } from "./project.js";
import type { TemplateSource } from "./source.js";

export { INCOMING_DIR };

const LOCKFILE = "pnpm-lock.yaml";

/** One side of an update: the Starter revision and the selection to render. */
export interface UpdateSide {
  source: Pick<TemplateSource, "root" | "files" | "repository" | "ref" | "commit">;
  manifest: TemplateManifest;
  /** The stack per slot; the project's own when absent. add and remove change its apps here. */
  stacks?: Record<string, string>;
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
  /**
   * Each app's local env file, such as apps/web/.env.local; `update` is null when it does not
   * exist. An app the change adds gets its env file from its example (`create`), as a new project
   * does.
   */
  envs: Array<{ path: string; update: EnvUpdate | null; changed: boolean; create?: Buffer }>;
}

export async function planUpdate(project: Project, base: UpdateSide, target: UpdateSide): Promise<UpdatePlan> {
  const render = (side: UpdateSide) =>
    renderProject({
      source: side.source,
      manifest: side.manifest,
      identity: project.identity,
      stacks: side.stacks ?? project.stacks,
      modules: side.modules,
      cliVersion: side.cliVersion,
    });
  const before = await render(base);
  const after = await render(target);

  // The lockfile and the local env files are handled on their own below. The env file of an app
  // the change removes is left as it is: it is the developer's, and Git ignores it.
  const envFiles = after.envFiles;
  const removedEnvFiles = before.envFiles.filter(({ to }) => !after.envFiles.some((file) => file.to === to));
  const special = [LOCKFILE, ...[...envFiles, ...removedEnvFiles].map(({ to }) => to)];
  const strip = (files: Map<string, Buffer>) =>
    new Map([...files].filter(([path]) => !special.includes(path)));
  const baseFiles = strip(before.files);
  const targetFiles = strip(after.files);
  const current = await readProjectFiles(project.root, [
    ...new Set([...baseFiles.keys(), ...targetFiles.keys(), ...special]),
  ]);

  const currentReadme = current.get("README.md");
  const customReadme = Boolean(
    currentReadme && !currentReadme.toString("utf8").includes("## Generated from"),
  );
  const targetReadme = targetFiles.get("README.md");
  if (customReadme) {
    baseFiles.delete("README.md");
    targetFiles.delete("README.md");
  }

  // Workspace apps take the new Starter's version unless the project customized their version.
  for (const [path, targetContent] of targetFiles) {
    if (!path.startsWith("apps/") || !path.endsWith("/package.json")) continue;
    const baseContent = baseFiles.get(path);
    const currentContent = current.get(path);
    if (!baseContent || !currentContent) continue;
    try {
      const basePkg = JSON.parse(baseContent.toString("utf8"));
      const currentPkg = JSON.parse(currentContent.toString("utf8"));
      if (typeof currentPkg.version === "string" && currentPkg.version !== basePkg.version) {
        baseFiles.set(path, Buffer.from(customizeAppManifest(baseContent.toString("utf8"), undefined, currentPkg.version)));
        targetFiles.set(path, Buffer.from(customizeAppManifest(targetContent.toString("utf8"), undefined, currentPkg.version)));
      }
    } catch {
      // Leave unparseable manifests untouched.
    }
  }

  const actions = planMerge(baseFiles, targetFiles, current);
  if (customReadme && targetReadme && !sameContent(currentReadme!, targetReadme)) {
    actions.push({
      path: "README.md",
      kind: "keep",
      reason: "You replaced the generated README with your own.",
      incoming: targetReadme,
    });
    actions.sort((a, b) => a.path.localeCompare(b.path));
  }

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

  const envs = envFiles.map((envFile) => {
    const text = (files: Map<string, Buffer>) => files.get(envFile.from)?.toString("utf8") ?? "";
    const local = current.get(envFile.to)?.toString("utf8");
    const update = local === undefined ? null : updateEnvFile(local, text(before.files), text(after.files));
    const added = !before.envFiles.some(({ to }) => to === envFile.to);
    const example = after.files.get(envFile.from);
    return {
      path: envFile.to,
      update,
      changed: update !== null && update.text !== local,
      ...(local === undefined && added && example ? { create: example } : {}),
    };
  });

  return { project, actions, lockfile, envs };
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

/** The Starter's version of each file left for you: conflicts, and kept files it has a version of. */
export function incomingFiles(plan: UpdatePlan): Array<{ path: string; content: Buffer }> {
  return plan.actions.flatMap((action) =>
    (action.kind === "conflict" || action.kind === "keep") && action.incoming ? [{ path: action.path, content: action.incoming }] : [],
  );
}

/** Replaces the previous change's incoming files with this change's. */
async function writeIncoming(plan: UpdatePlan) {
  const folder = join(plan.project.root, INCOMING_DIR);
  await rm(folder, { recursive: true, force: true });
  const files = incomingFiles(plan);
  if (!files.length) return;
  await mkdir(dirname(folder), { recursive: true });
  await writeFile(
    join(dirname(folder), ".gitignore"),
    "# Written by create-clubedge-app: the Starter's versions of files to compare. Delete when done.\n*\n",
  );
  for (const file of files) {
    const path = join(folder, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
  }
}

export async function applyUpdate(plan: UpdatePlan): Promise<void> {
  const { root } = plan.project;
  await writeIncoming(plan);
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
  for (const env of plan.envs) {
    if (env.update && env.changed) await writeFile(join(root, env.path), env.update.text);
    if (env.create) {
      await mkdir(dirname(join(root, env.path)), { recursive: true });
      // An env file written since the plan was made is never replaced.
      await writeFile(join(root, env.path), env.create, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
  }
}
