// pnpm stops `pnpm install` on a patch it does not use (ERR_PNPM_UNUSED_PATCH). `pnpm patch-commit`
// keys a patch by the exact version it was made on, so a change that moves the dependency to a
// range without that version leaves the patch unused, and the install stops. These find such
// patches once the change is written, so the CLI can say which and what to do, instead of pnpm
// stopping on them.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listTemplateFiles, pathExists } from "../utils/fs.js";

export interface UnusedPatch {
  /** The key in patchedDependencies: the package and the exact version it was made on. */
  key: string;
  name: string;
  version: string;
  /** The patch file, as the key names it. */
  patch: string;
  /** Where the key is: package.json or pnpm-workspace.yaml. */
  file: string;
  /** The project's ranges for the package now, none of which allow that version. */
  ranges: string[];
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RANGE = /^([\^~])(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Whether a range allows a version: an exact version, or a ^ or ~ range on a full version.
 * Undefined for any other range, which this cannot tell.
 */
export function allows(range: string, version: string): boolean | undefined {
  const wanted = VERSION.exec(version)?.slice(1).map(Number);
  if (!wanted) return undefined;
  const exact = VERSION.exec(range);
  if (exact) return exact[0] === version;
  const match = RANGE.exec(range);
  if (!match) return undefined;
  const floor = match.slice(2).map(Number);
  // How many numbers the range keeps: ~ the major and minor, ^ up to its first one that is not 0.
  const kept = match[1] === "~" ? 2 : floor.findIndex((n) => n !== 0) + 1 || 3;
  if (floor.slice(0, kept).some((n, i) => n !== wanted[i])) return false;
  const differs = floor.findIndex((n, i) => n !== wanted[i]);
  return differs === -1 || wanted[differs]! > floor[differs]!;
}

/** `zod@4.6.5` or `@scope/pkg@1.2.3` into the package and its version; null for a key without an exact one. */
function splitKey(key: string): { name: string; version: string } | null {
  const at = key.lastIndexOf("@");
  if (at <= 0) return null;
  const [name, version] = [key.slice(0, at), key.slice(at + 1)];
  return VERSION.test(version) ? { name, version } : null;
}

/** The patchedDependencies block of pnpm-workspace.yaml: indented `key: path` lines after its own line. */
function workspacePatches(yaml: string): Array<[string, string]> {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^patchedDependencies:\s*(#.*)?$/.test(line));
  if (start === -1) return [];
  const entries: Array<[string, string]> = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) break;
    const entry = /^\s+(['"]?)(.+?)\1\s*:\s*(['"]?)(.+?)\3\s*(#.*)?$/.exec(line);
    if (entry) entries.push([entry[2]!, entry[4]!]);
  }
  return entries;
}

/** Every patch the project declares, with the file that declares it. */
async function declaredPatches(root: string): Promise<Array<{ key: string; patch: string; file: string }>> {
  const patches: Array<{ key: string; patch: string; file: string }> = [];
  try {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    for (const [key, patch] of Object.entries(manifest.pnpm?.patchedDependencies ?? {})) {
      if (typeof patch === "string") patches.push({ key, patch, file: "package.json" });
    }
  } catch {
    // An unreadable package.json is reported elsewhere.
  }
  if (await pathExists(join(root, "pnpm-workspace.yaml"))) {
    for (const [key, patch] of workspacePatches(await readFile(join(root, "pnpm-workspace.yaml"), "utf8"))) {
      patches.push({ key, patch, file: "pnpm-workspace.yaml" });
    }
  }
  return patches;
}

/** Each package's ranges across the workspace's package.json files; an override replaces them. */
async function dependencyRanges(root: string): Promise<Map<string, string[]>> {
  const ranges = new Map<string, string[]>();
  const overrides: Record<string, unknown> = {};
  for (const path of (await listTemplateFiles(root)).filter((file) => /(^|\/)package\.json$/.test(file))) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(root, path), "utf8"));
    } catch {
      continue;
    }
    if (path === "package.json") Object.assign(overrides, manifest.pnpm?.overrides ?? {});
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (typeof range === "string") ranges.set(name, [...(ranges.get(name) ?? []), range]);
      }
    }
  }
  for (const [name, range] of Object.entries(overrides)) {
    if (typeof range === "string" && ranges.has(name)) ranges.set(name, [range]);
  }
  return ranges;
}

/**
 * Patches keyed by an exact version that none of the project's ranges for the package allows,
 * which pnpm would leave unused. A patch on a package no package.json names (a dependency of a
 * dependency), or with a range this cannot read, is left out: pnpm decides those.
 */
export async function unusedPatches(root: string): Promise<UnusedPatch[]> {
  const declared = await declaredPatches(root);
  if (!declared.length) return [];
  const ranges = await dependencyRanges(root);
  const unused: UnusedPatch[] = [];
  for (const { key, patch, file } of declared) {
    const parsed = splitKey(key);
    const own = parsed ? ranges.get(parsed.name) : undefined;
    if (!parsed || !own?.length) continue;
    if (own.every((range) => allows(range, parsed.version) === false)) unused.push({ key, ...parsed, patch, file, ranges: own });
  }
  return unused;
}

/** What to tell the developer about patches pnpm would not use, and how to keep them. */
export function unusedPatchWarning(patches: UnusedPatch[], installSkipped: boolean): string {
  const lines = patches.map(
    ({ key, name, patch, file, ranges }) => `  ${key} (${patch}, in ${file}): the project now asks for ${name} ${[...new Set(ranges)].join(" or ")}`,
  );
  const [first] = patches as [UnusedPatch];
  // The key by the package alone, written as its file writes keys.
  const byName =
    first.file === "package.json"
      ? `"${first.name}": "${first.patch}"`
      : `${first.name.startsWith("@") ? `'${first.name}'` : first.name}: ${first.patch}`;
  return [
    `${installSkipped ? "Skipped `pnpm install`: it would stop" : "`pnpm install` will stop"} on ${patches.length === 1 ? "a patch" : "patches"} made for a version the change moves away from (ERR_PNPM_UNUSED_PATCH):`,
    ...lines,
    `To try ${patches.length === 1 ? "it" : "each"} on the new version, key it by the package alone in ${first.file}, as \`${byName}\`: pnpm then applies it to the version it installs, and says so if it no longer fits. Or make it again with \`pnpm patch ${first.name}\`. Then run \`pnpm install\`.`,
  ].join("\n");
}
