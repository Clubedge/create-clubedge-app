import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  addRoadmapRows,
  bumpVersion,
  changelogEntry,
  changelogLine,
  changelogSection,
  insertChangelog,
  mergedPullRequests,
  releaseSummary,
  updatePinDocs,
  updateVersionDocs,
} from "../scripts/release-lib.mjs";

// The edits run on the repository's own files, so a wording change that breaks a release fails here.
const file = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const pkg = JSON.parse(file("package.json")) as { version: string; clubedge: { starterRef: string; starterCommit: string } };
const docs = { readme: file("README.md"), contributing: file("CONTRIBUTING.md") };

describe("release versions", () => {
  it("bumps patch, minor, and major", () => {
    expect(bumpVersion("0.20.0", "patch")).toBe("0.20.1");
    expect(bumpVersion("0.20.3", "minor")).toBe("0.21.0");
    expect(bumpVersion("0.20.3", "major")).toBe("1.0.0");
    expect(() => bumpVersion("0.20.0", "huge")).toThrow(/patch, minor, or major/);
  });

  it("moves the CLI version in the README and CONTRIBUTING", () => {
    const next = bumpVersion(pkg.version, "minor");
    const updated = updateVersionDocs(docs, pkg.version, next);
    expect(updated.readme).toContain(`create-clubedge-app v${next}\n`);
    expect(updated.readme).toContain(`\`create-clubedge-app@${next}\``);
    expect(updated.contributing).toContain(`create-clubedge-app v${next} ->`);
    expect(updated.readme).not.toContain(`\`create-clubedge-app@${pkg.version}\``);
  });

  it("fails clearly when the docs no longer name the version", () => {
    expect(() => updateVersionDocs(docs, "9.9.9", "9.9.10")).toThrow(/README.md: expected/);
  });
});

describe("Starter pin", () => {
  const from = { ref: pkg.clubedge.starterRef, commit: pkg.clubedge.starterCommit };
  const to = { ref: "v9.9.9", commit: "a".repeat(40) };

  it("moves every current mention, and none in the release history", () => {
    const updated = updatePinDocs(docs, from, to);
    const history = (text: string) => text.split("\n").filter((line) => /^\| \d+\.\d+\.\d+ \| /.test(line));
    expect(history(updated.readme)).toEqual(history(docs.readme));
    const current = (text: string) => text.split("\n").filter((line) => !/^\| \d+\.\d+\.\d+ \| /.test(line)).join("\n");
    expect(current(updated.readme)).not.toContain(from.commit);
    expect(current(updated.readme)).not.toMatch(new RegExp(`\\b${from.ref.replaceAll(".", "\\.")}\\b`));
    expect(updated.readme).toContain(`commit ${to.commit}`);
    expect(updated.contributing).toContain(`"starterRef": "${to.ref}"`);
    expect(updated.contributing).toContain(`"starterCommit": "${to.commit}"`);
  });

  it("matches whole tags only", () => {
    const text = { readme: "Starter v0.15.0, not v0.15.01 or v0.15.0.1", contributing: "" };
    expect(updatePinDocs(text, { ref: "v0.15.0", commit: "x".repeat(40) }, to).readme).toBe("Starter v9.9.9, not v0.15.01 or v0.15.0.1");
  });
});

describe("changelog draft", () => {
  const log = [
    "Merge pull request #49 from Clubedge/release/v0.20.0\x1fchore: release v0.20.0\n\x1e",
    "deploy: use your own databases (#51)\x1fWith DATABASE_URL in the env file (#3 in the body).\n\x1e",
    "chore: release v0.19.1 (#50)\x1f\x1e",
    "Merge pull request #48 from Clubedge/feat/try-share\x1ffeat: share a try preview by claiming the VM\n\x1e",
    "Merge pull request #47 from Clubedge/feat/conflict-incoming\x1ffix(merge): keep CRLF in incoming files\n\nDetails.\x1e",
    "Some direct commit\x1f\x1e",
  ].join("\n");

  it("lists merged and squashed pull requests oldest first, without releases or direct commits", () => {
    expect(mergedPullRequests(log)).toEqual([
      { number: 47, title: "fix(merge): keep CRLF in incoming files" },
      { number: 48, title: "feat: share a try preview by claiming the VM" },
      { number: 51, title: "deploy: use your own databases" },
    ]);
  });

  it("lists a Starter pin pull request once, instead of a second Starter line", () => {
    const pinned = [
      { number: 50, title: "ci: name the failing check" },
      { number: 52, title: "feat: default to Starter v0.16.0" },
    ];
    expect(changelogEntry("0.21.0", pinned, "v0.16.0", true)).toBe(
      "## 0.21.0\n\n- Name the failing check (#50).\n- Default to Starter `v0.16.0` (#52).\n",
    );
    // A pin pull request for another release does not stand in for this one.
    expect(changelogEntry("0.21.0", pinned, "v0.17.0", true)).toContain("- Default to Starter `v0.17.0`.");
  });

  it("turns conventional titles into changelog lines", () => {
    expect(changelogLine("feat(cli)!: add try")).toBe("Add try");
    expect(changelogLine("Plain title")).toBe("Plain title");
  });

  it("drafts an entry and puts it above the newest release", () => {
    const entry = changelogEntry("0.21.0", mergedPullRequests(log), "v0.15.0", false);
    expect(entry).toBe(
      "## 0.21.0\n\n- Keep CRLF in incoming files (#47).\n- Share a try preview by claiming the VM (#48).\n- Use your own databases (#51).\n- Still on Starter `v0.15.0`.\n",
    );
    expect(changelogEntry("0.21.0", [], "v0.16.0", true)).toContain("- Default to Starter `v0.16.0`.");

    // Inserted into the real changelog as the next release, which never has an entry yet.
    const next = bumpVersion(pkg.version, "major");
    const changelog = insertChangelog(file("CHANGELOG.md"), changelogEntry(next, mergedPullRequests(log), "v0.15.0", false));
    expect(changelog.indexOf(`## ${next}`)).toBeLessThan(changelog.indexOf(`## ${pkg.version}`));
    expect(changelogSection(changelog, next)).toContain("(#47)");
    expect(changelogSection(changelog, "9.9.9")).toBe("");
  });
});

describe("release tables", () => {
  it("adds a row after the last one in the README and ROADMAP.md", () => {
    // Patch releases have no row, so compare with the last row there is, not the current version's.
    const lastRow = docs.readme.split("\n").filter((line) => /^\| \d+\.\d+\.\d+ \| /.test(line)).at(-1)!;
    const { readme, roadmap } = addRoadmapRows({ readme: docs.readme, roadmap: file("ROADMAP.md") }, "99.0.0", "v0.15.0", "Release tooling");
    expect(readme.indexOf("| 99.0.0 | v0.15.0 | Release tooling |")).toBeGreaterThan(readme.indexOf(lastRow));
    expect(roadmap).toMatch(/^\| \d+ \| 99\.0\.0 \| Release tooling \|$/m);
  });

  it("leaves dependency bumps out of a row unless that is all there is", () => {
    const bump = { number: 68, title: "chore(deps): bump @types/node from 22.20.5 to 26.6.5" };
    const devBump = { number: 104, title: "chore(deps-dev): bump vitest from 5.0.3 to 5.0.5" };
    const pin = { number: 107, title: "feat: default to Starter v0.24.1" };
    expect(releaseSummary([bump, pin, devBump])).toBe("Default to Starter v0.24.1");
    expect(releaseSummary([bump, devBump])).toBe("Dependency updates");
  });
});
