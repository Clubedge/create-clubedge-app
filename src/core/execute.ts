import { constants } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { copyTemplateFiles, emptyDirectory, pathExists } from "../utils/fs.js";
import type { ScaffoldPlan } from "./plan.js";
import type { TemplateSource } from "./source.js";

export class TargetError extends Error {
  override name = "TargetError";
}

/** Refuses filesystem roots and non-empty directories. Never deletes or overwrites anything. */
export async function assertTargetIsUsable(directory: string): Promise<void> {
  if (parse(directory).root === directory) {
    throw new TargetError("Choose a project subdirectory rather than a filesystem root.");
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

/**
 * Writes the project described by the plan. If any step fails, everything written so far is
 * removed: a directory the CLI created is deleted, and a pre-existing empty one is emptied.
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

  try {
    await copyTemplateFiles(source.root, target, plan.files);
    for (const edit of plan.edits) {
      const path = join(target, edit.path);
      await writeFile(path, edit.apply(await readFile(path, "utf8")));
    }
    if (plan.envFile) {
      await copyFile(join(target, plan.envFile.from), join(target, plan.envFile.to), constants.COPYFILE_EXCL);
    }
  } catch (error) {
    if (created) await rm(target, { recursive: true, force: true });
    else await emptyDirectory(target);
    throw error;
  }
}
