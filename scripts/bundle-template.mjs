// Bundles the pinned Starter release into this package (template/ and template.lock.json) so
// the published CLI scaffolds offline, without depending on GitHub at run time.
//
//   node scripts/bundle-template.mjs                  clone the pinned tag and verify its commit
//   node scripts/bundle-template.mjs --from <path>    bundle a local Starter checkout (testing)

import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const templateDirectory = join(packageRoot, "template");
const lockFile = join(packageRoot, "template.lock.json");
const { clubedge: pin } = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));

// npm drops these names from tarballs; the CLI restores them (see src/utils/fs.ts).
const packedFileNames = { ".gitignore": "_gitignore", ".npmrc": "_npmrc" };
const toPackedPath = (path) => {
  const parts = path.split("/");
  const last = parts.pop();
  return [...parts, packedFileNames[last] ?? last].join("/");
};

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const { values } = parseArgs({ options: { from: { type: "string" } } });

let sourceRoot = values.from;
let temporary;
let ref = pin.starterRef;
let commit = pin.starterCommit;

if (!sourceRoot) {
  temporary = await mkdtemp(join(tmpdir(), "clubedge-template-"));
  sourceRoot = join(temporary, "starter");
  const url = `https://github.com/${pin.starterRepository}.git`;
  git(["clone", "--quiet", "--depth", "1", "--branch", pin.starterRef, url, sourceRoot]);
  const resolved = git(["rev-parse", "HEAD"], sourceRoot);
  if (resolved !== pin.starterCommit) {
    throw new Error(`Starter ${pin.starterRef} resolved to ${resolved}, expected ${pin.starterCommit}.`);
  }
} else {
  ref = "local";
  commit = git(["rev-parse", "HEAD"], sourceRoot);
}

try {
  const manifestPath = join(sourceRoot, "clubedge.template.json");
  const exclude = await readFile(manifestPath, "utf8")
    .then((source) => JSON.parse(source).exclude ?? [])
    .catch(() => []);
  const isExcluded = (path) => exclude.some((entry) => path === entry || path.startsWith(`${entry}/`));

  // The manifest itself is read by the CLI at scaffold time, so it is always bundled.
  const files = git(["ls-files", "-z"], sourceRoot)
    .split("\0")
    .filter(Boolean)
    .filter((file) => file === "clubedge.template.json" || !isExcluded(file))
    .sort();

  await rm(templateDirectory, { recursive: true, force: true });
  const packed = [];
  for (const file of files) {
    const target = toPackedPath(file);
    await mkdir(dirname(join(templateDirectory, target)), { recursive: true });
    await cp(join(sourceRoot, file), join(templateDirectory, target));
    packed.push(target);
  }

  const lock = { repository: pin.starterRepository, ref, commit, files: packed };
  await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`Bundled ${packed.length} files from ${pin.starterRepository}@${ref} (${commit.slice(0, 8)}).`);
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
