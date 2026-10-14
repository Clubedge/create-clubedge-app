#!/usr/bin/env node
// Release tooling for maintainers (see "Release workflow" in the README):
//
//   pnpm release patch|minor|major [--dry-run]   open the release pull request
//   pnpm release tag [--dry-run]                 after it is merged: tag main, which publishes
//   pnpm release pin <tag> [--commit <sha>]      move the Starter pin (the starter-pin workflow runs this)
//
// The release pull request bumps the version, updates the docs that name it, and drafts the
// changelog entry from the pull requests merged since the last tag. Edit the draft before merging.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addRoadmapRows,
  bumpVersion,
  changelogEntry,
  changelogLine,
  changelogSection,
  insertChangelog,
  mergedPullRequests,
  updatePinDocs,
  updateVersionDocs,
} from "./release-lib.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [command, value] = args.filter((arg) => !arg.startsWith("--"));

const run = (file, argv, options = {}) =>
  execFileSync(file, argv, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
const git = (...argv) => run("git", argv);

// Files are edited with LF line endings and written back in the ones they had.
const read = (path) => {
  const text = readFileSync(join(root, path), "utf8");
  return { text: text.replace(/\r\n/g, "\n"), crlf: text.includes("\r\n") };
};
const files = new Map();
const load = (path) => {
  if (!files.has(path)) files.set(path, read(path));
  return files.get(path).text;
};
const save = (path, text) => files.set(path, { ...(files.get(path) ?? read(path)), text, changed: true });
const writeAll = () => {
  for (const [path, file] of files) {
    if (file.changed) writeFileSync(join(root, path), file.crlf ? file.text.replace(/\n/g, "\r\n") : file.text);
  }
};

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

/** Releases start from an up-to-date, clean main. A dry run only warns, so it works from anywhere. */
function assertCleanMain() {
  const problem = dryRun ? (message) => console.warn(`Warning: ${message}`) : fail;
  if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") problem("Switch to main first.");
  if (git("status", "--porcelain")) problem("Commit or stash your changes first.");
  git("fetch", "--quiet", "origin", "main", "--tags");
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) problem("main is not up to date with origin/main: pull first.");
}

function packageJson() {
  return JSON.parse(load("package.json"));
}

/** Opens the release pull request: version, docs, and a changelog draft. */
function prepare(kind) {
  assertCleanMain();
  const pkg = packageJson();
  const current = pkg.version;
  const next = bumpVersion(current, kind);
  const tag = `v${next}`;
  if (git("tag", "--list", tag)) fail(`${tag} already exists.`);

  const previousTag = `v${current}`;
  const range = git("tag", "--list", previousTag) ? `${previousTag}..HEAD` : "HEAD";
  const pullRequests = mergedPullRequests(git("log", range, "--first-parent", "--format=%s%x1f%b%x1e"));
  if (!pullRequests.length) fail(`Nothing merged since ${previousTag}.`);

  const starterRef = pkg.clubedge.starterRef;
  let pinChanged = false;
  try {
    pinChanged = JSON.parse(git("show", `${previousTag}:package.json`)).clubedge.starterRef !== starterRef;
  } catch {
    // No previous tag: the first release.
  }

  save("package.json", load("package.json").replace(`"version": "${current}"`, `"version": "${next}"`));
  const docs = updateVersionDocs({ readme: load("README.md"), contributing: load("CONTRIBUTING.md") }, current, next);
  save("CONTRIBUTING.md", docs.contributing);
  let readme = docs.readme;
  if (kind !== "patch") {
    const summary = pullRequests.map((pr) => changelogLine(pr.title)).join("; ");
    const rows = addRoadmapRows({ readme, roadmap: load("ROADMAP.md") }, next, starterRef, summary);
    readme = rows.readme;
    save("ROADMAP.md", rows.roadmap);
  }
  save("README.md", readme);
  const entry = changelogEntry(next, pullRequests, starterRef, pinChanged);
  save("CHANGELOG.md", insertChangelog(load("CHANGELOG.md"), entry));

  console.log(`${current} -> ${next} (${kind}), Starter ${starterRef}\n\n${entry}`);
  if (dryRun) {
    console.log(`Dry run: would change ${[...files].filter(([, f]) => f.changed).map(([p]) => p).join(", ")}, then open a release pull request.`);
    return;
  }

  writeAll();
  const branch = `release/${tag}`;
  git("switch", "--create", branch);
  git("add", ...[...files].filter(([, f]) => f.changed).map(([p]) => p));
  git("commit", "--quiet", "--message", `chore: release ${tag}`);
  git("push", "--quiet", "--set-upstream", "origin", branch);
  const body = [
    `Releases CLI \`${next}\` on Starter \`${starterRef}\`.`,
    "",
    "Changelog draft, from the pull requests merged since the last release. **Edit it in this pull request before merging:** it becomes the GitHub Release page.",
    "",
    entry.replace(/^## .*\n\n/, ""),
    `After merging: \`pnpm release tag\` on main publishes \`${tag}\`.`,
  ].join("\n");
  const url = run("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", `chore: release ${tag}`, "--body", body]);
  console.log(`Opened ${url}`);
}

/** Tags main with the merged release's version; the Release workflow publishes it. */
function tagRelease() {
  assertCleanMain();
  const version = packageJson().version;
  const tag = `v${version}`;
  if (git("tag", "--list", tag) || git("ls-remote", "--tags", "origin", tag)) fail(`${tag} already exists.`);
  if (!changelogSection(load("CHANGELOG.md"), version)) fail(`CHANGELOG.md has no "## ${version}" entry.`);
  if (dryRun) {
    console.log(`Dry run: would tag ${git("rev-parse", "--short", "HEAD")} as ${tag} and push it.`);
    return;
  }
  git("tag", tag);
  git("push", "--quiet", "origin", tag);
  console.log(`Pushed ${tag}: the Release workflow publishes it to npm and creates the release page.`);
}

/** Moves the Starter pin to a tag, in package.json and the docs. */
function pin(ref) {
  if (!/^v\d+\.\d+\.\d+$/.test(ref ?? "")) fail("Usage: pnpm release pin vX.Y.Z [--commit <sha>]");
  const pkg = packageJson();
  const repository = pkg.clubedge.starterRepository;
  const commitArg = args[args.indexOf("--commit") + 1];
  const commit =
    args.includes("--commit") && commitArg
      ? commitArg
      : run("gh", ["api", `repos/${repository}/commits/${ref}`, "--jq", ".sha"]);
  if (!/^[0-9a-f]{40}$/.test(commit)) fail(`Not a full commit SHA for ${ref}: ${commit}`);
  const from = { ref: pkg.clubedge.starterRef, commit: pkg.clubedge.starterCommit };
  if (from.ref === ref && from.commit === commit) {
    console.log(`Already pinned to ${ref}.`);
    return;
  }
  save(
    "package.json",
    load("package.json")
      .replace(`"starterRef": "${from.ref}"`, `"starterRef": "${ref}"`)
      .replace(`"starterCommit": "${from.commit}"`, `"starterCommit": "${commit}"`),
  );
  const docs = updatePinDocs({ readme: load("README.md"), contributing: load("CONTRIBUTING.md") }, from, { ref, commit });
  save("README.md", docs.readme);
  save("CONTRIBUTING.md", docs.contributing);
  console.log(`Starter pin ${from.ref} -> ${ref} (${commit})`);
  if (dryRun) return;
  writeAll();
}

if (command === "patch" || command === "minor" || command === "major") prepare(command);
else if (command === "tag") tagRelease();
else if (command === "pin") pin(value);
else fail("Usage: pnpm release patch|minor|major [--dry-run] | tag [--dry-run] | pin vX.Y.Z [--commit <sha>]");
