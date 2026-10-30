import { constants } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve } from "node:path";
import { copyTemplateFiles, pathExists } from "../utils/fs.js";
import { isReservedDeviceName } from "../utils/names.js";
import type { ScaffoldPlan } from "./plan.js";
import type { TemplateSource } from "./source.js";

export class TargetError extends Error {
  override name = "TargetError";
}

/** Refuses filesystem roots, reserved Windows device names, and non-empty directories. Never deletes or overwrites anything. */
export async function assertTargetIsUsable(directory: string): Promise<void> {
  if (parse(directory).root === directory) {
    throw new TargetError("Choose a project subdirectory rather than a filesystem root.");
  }
  // Check the project's own name and each missing parent that executePlan would create. A parent
  // that already exists is left alone, such as a home folder named con on macOS.
  let folder = directory;
  while (true) {
    const name = basename(folder);
    if (isReservedDeviceName(name)) {
      throw new TargetError(`"${name}" is a reserved device name on Windows. Choose another directory name.`);
    }
    const parent = dirname(folder);
    if (parent === folder || (await pathExists(parent))) break;
    folder = parent;
  }
  try {
    const entries = await readdir(directory);
    if (entries.length > 0) throw new TargetError(`The target directory is not empty: ${directory}`);
  } catch (error) {
    if (error instanceof TargetError) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

/** Removes files created during scaffolding, then removes any empty directories left behind. */
export async function cleanupWrittenFiles(target: string, files: string[]): Promise<void> {
  const dirs = new Set<string>();
  const targetPath = resolve(target);
  for (const file of files) {
    await rm(file, { force: true }).catch(() => {});
    for (let cur = resolve(dirname(file)); cur !== targetPath && cur !== dirname(cur) && !relative(targetPath, cur).startsWith(".."); cur = dirname(cur)) {
      dirs.add(cur);
    }
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    await rmdir(dir).catch(() => {});
  }
}

/**
 * Writes the project described by the plan. If any step fails, everything written so far is
 * removed: a directory the CLI created is deleted, and for a pre-existing directory only files
 * created during the run are removed, preserving any pre-existing contents.
 */
export async function executePlan(plan: ScaffoldPlan, source: Pick<TemplateSource, "root">): Promise<void> {
  const target = plan.targetDirectory;
  await assertTargetIsUsable(target);
  // Only create a missing parent: on Windows, mkdir on an existing drive root (D:\) fails.
  if (!(await pathExists(dirname(target)))) await mkdir(dirname(target), { recursive: true });

  let created = false;
  try {
    await mkdir(target);
    created = true;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
  }

  const written: string[] = [];
  try {
    await copyTemplateFiles(source.root, target, plan.files, written);
    for (const edit of plan.edits) {
      const path = join(target, edit.path);
      await writeFile(path, edit.apply(await readFile(path, "utf8")));
    }
    for (const envFile of plan.envFiles) {
      const destination = join(target, envFile.to);
      await copyFile(join(target, envFile.from), destination, constants.COPYFILE_EXCL);
      written.push(destination);
    }
  } catch (error) {
    if (created) await rm(target, { recursive: true, force: true });
    else await cleanupWrittenFiles(target, written);
    throw error;
  }
}
