// The text edits a CLI release makes, as pure functions: scripts/release.mjs runs them on the
// repository's files, and test/release.test.ts checks them. No I/O here.

/** "0.20.0" -> the next patch, minor, or major version. */
export function bumpVersion(version, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Not a plain version: ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  if (kind === "major") return `${major + 1}.0.0`;
  throw new Error(`Unknown release kind "${kind}": use patch, minor, or major.`);
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const replaceOnce = (text, from, to, file) => {
  if (!text.includes(from)) throw new Error(`${file}: expected "${from}" to update.`);
  return text.replace(from, to);
};

/** The CLI version in the README's version relationship and in CONTRIBUTING. */
export function updateVersionDocs({ readme, contributing }, from, to) {
  return {
    readme: replaceOnce(
      replaceOnce(readme, `create-clubedge-app v${from}\n`, `create-clubedge-app v${to}\n`, "README.md"),
      `\`create-clubedge-app@${from}\``,
      `\`create-clubedge-app@${to}\``,
      "README.md",
    ),
    contributing: replaceOnce(contributing, `create-clubedge-app v${from} ->`, `create-clubedge-app v${to} ->`, "CONTRIBUTING.md"),
  };
}

/** A row of the README's release table (`| 0.17.0 | v0.15.0 | ... |`): history, never rewritten. */
const historyRow = /^\| \d+\.\d+\.\d+ \| /;

/**
 * Moves the Starter pin's tag and commit everywhere the docs name the current pin, leaving the
 * README's release history, and the releases changes came with ("since Starter v0.15.0", "since
 * CLI 0.17.0, with Starter v0.15.0"), as they were.
 */
export function updatePinDocs({ readme, contributing }, from, to) {
  // The whole tag only: not v0.15.01 or v0.15.0.1, while a sentence's closing period still matches.
  const tag = new RegExp(
    `(?<![\\w.])(?<!since Starter )(?<!since CLI \\d+\\.\\d+\\.\\d+, with Starter )${escape(from.ref)}(?![\\w-]|\\.\\d)`,
    "g",
  );
  const swap = (line) => line.replace(tag, to.ref).replaceAll(from.commit, to.commit);
  return {
    readme: readme
      .split("\n")
      .map((line) => (historyRow.test(line) ? line : swap(line)))
      .join("\n"),
    contributing: contributing.split("\n").map(swap).join("\n"),
  };
}

/**
 * Pull requests merged since the last release, from `git log --first-parent --format=%s%x1f%b%x1e`:
 * a merge commit's subject has the number and its body's first line the title; a squash merge's
 * subject is the title, ending in "(#number)". Release pull requests and direct commits are left out.
 */
export function mergedPullRequests(log) {
  return log
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const [subject = "", body = ""] = entry.split("\x1f");
      const merged = /^Merge pull request #(\d+)/.exec(subject);
      const squashed = merged ? null : /^(.+?)\s+\(#(\d+)\)$/.exec(subject.trim());
      const number = merged?.[1] ?? squashed?.[2];
      const title = merged ? body.trim().split("\n")[0]?.trim() : squashed?.[1];
      if (!number || !title || /^chore: release v/.test(title)) return [];
      return [{ number: Number(number), title }];
    })
    .reverse();
}

/** "feat(cli): add try" -> "Add try": a changelog line from a conventional title. */
export function changelogLine(title) {
  const text = title.replace(/^[a-z]+(\([^)]*\))?!?:\s*/, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The release table's row text: the pull requests' lines, without dependency bumps unless that is all there is. */
export function releaseSummary(pullRequests) {
  const isBump = (pr) => /^(chore|build)\(deps(-dev)?\):/.test(pr.title);
  const features = pullRequests.filter((pr) => !isBump(pr));
  if (!features.length) return "Dependency updates";
  return features.map((pr) => changelogLine(pr.title)).join("; ");
}

/** The draft entry for a release: one line per pull request, then the Starter it uses. */
export function changelogEntry(version, pullRequests, starterRef, pinChanged) {
  // The Starter pin pull request ("feat: default to Starter vX") already says what the pin line would.
  const pinRequest = (pr) => pinChanged && /\bdefault to starter\b/i.test(pr.title) && pr.title.includes(starterRef);
  const lines = pullRequests.map((pr) => {
    const line = changelogLine(pr.title);
    return `- ${pinRequest(pr) ? line.replace(starterRef, `\`${starterRef}\``) : line} (#${pr.number}).`;
  });
  if (!pullRequests.some(pinRequest)) {
    lines.push(pinChanged ? `- Default to Starter \`${starterRef}\`.` : `- Still on Starter \`${starterRef}\`.`);
  }
  return `## ${version}\n\n${lines.join("\n")}\n`;
}

/** Puts an entry above the newest one in CHANGELOG.md. */
export function insertChangelog(changelog, entry) {
  const at = changelog.search(/^## \d/m);
  if (at === -1) throw new Error("CHANGELOG.md: no release entry to insert above.");
  return `${changelog.slice(0, at)}${entry}\n${changelog.slice(at)}`;
}

/** A version's entry from CHANGELOG.md, without its heading; empty when there is none. */
export function changelogSection(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.indexOf(`## ${version}`);
  if (start === -1) return "";
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
}

/** Adds a row for a minor or major release to the README's and ROADMAP.md's release tables. */
export function addRoadmapRows({ readme, roadmap }, version, starterRef, summary) {
  const after = (text, row, newRow, file) => {
    const lines = text.split("\n");
    const last = lines.findLastIndex((line) => row.test(line));
    if (last === -1) throw new Error(`${file}: no release table row to add after.`);
    lines.splice(last + 1, 0, typeof newRow === "function" ? newRow(lines[last]) : newRow);
    return lines.join("\n");
  };
  return {
    readme: after(readme, historyRow, `| ${version} | ${starterRef} | ${summary} |`, "README.md"),
    roadmap: after(
      roadmap,
      /^\| \d+(\.\d+)? \| \d+\.\d+\.\d+ \| /,
      (previous) => `| ${Math.floor(Number(/^\| (\d+(?:\.\d+)?) /.exec(previous)[1])) + 1} | ${version} | ${summary} |`,
      "ROADMAP.md",
    ),
  };
}
