import { describe, expect, it } from "vitest";
import { findUnneededOptionalPeers, pruneOptionalPeers } from "../src/core/lockfile-peers.js";

// A Starter-like lockfile after the CLI dropped packages/local-db: drizzle-orm still links
// pglite (only local-db installed it) and kysely (still installed through better-auth).
const lockfile = `lockfileVersion: '9.0'

importers:

  packages/db:
    dependencies:
      drizzle-orm:
        specifier: ^0.45.4
        version: 0.45.4(@electric-sql/pglite@0.5.8)(kysely@0.29.6)

  packages/auth-better-auth:
    dependencies:
      '@clubedge/db':
        specifier: workspace:*
        version: link:../db
      better-auth:
        specifier: ^1.7.7
        version: 1.7.7(drizzle-orm@0.45.4(@electric-sql/pglite@0.5.8)(kysely@0.29.6))

packages:

  '@electric-sql/pglite@0.5.8':
    resolution: {integrity: sha512-pglite}

  '@electric-sql/pglite-tools@1.0.0':
    resolution: {integrity: sha512-tools}

  better-auth@1.7.7:
    resolution: {integrity: sha512-better-auth}
    peerDependencies:
      drizzle-orm: '>=0.41.0'
    peerDependenciesMeta:
      drizzle-orm:
        optional: true

  drizzle-orm@0.45.4:
    resolution: {integrity: sha512-drizzle}
    peerDependencies:
      '@electric-sql/pglite': '>=0.2.0'
      kysely: '*'
    peerDependenciesMeta:
      '@electric-sql/pglite':
        optional: true
      kysely:
        optional: true

  kysely@0.29.6:
    resolution: {integrity: sha512-kysely}

snapshots:

  '@electric-sql/pglite@0.5.8': {}

  better-auth@1.7.7(drizzle-orm@0.45.4(@electric-sql/pglite@0.5.8)(kysely@0.29.6)):
    dependencies:
      kysely: 0.29.6
    optionalDependencies:
      drizzle-orm: 0.45.4(@electric-sql/pglite@0.5.8)(kysely@0.29.6)

  drizzle-orm@0.45.4(@electric-sql/pglite@0.5.8)(kysely@0.29.6):
    optionalDependencies:
      '@electric-sql/pglite': 0.5.8
      kysely: 0.29.6

  drizzle-orm@0.45.4(kysely@0.29.6):
    optionalDependencies:
      kysely: 0.29.6

  kysely@0.29.6: {}
`;

describe("findUnneededOptionalPeers", () => {
  it("finds optional peers that nothing else installs", () => {
    // drizzle-orm stays: better-auth's optional peer link, but packages/db depends on it directly.
    expect(findUnneededOptionalPeers(lockfile)).toEqual(["@electric-sql/pglite@0.5.8"]);
  });

  it("keeps optional peers that a remaining importer still installs", () => {
    const withPglite = lockfile.replace(
      "  packages/auth-better-auth:\n",
      "  packages/local-db:\n    dependencies:\n      '@electric-sql/pglite':\n        specifier: 0.5.8\n        version: 0.5.8\n\n  packages/auth-better-auth:\n",
    );
    expect(findUnneededOptionalPeers(withPglite)).toEqual([]);
    expect(pruneOptionalPeers(withPglite)).toBe(withPglite);
  });
});

describe("pruneOptionalPeers", () => {
  it("removes the links, merges snapshots that become identical, and keeps other packages", () => {
    const result = pruneOptionalPeers(lockfile);

    expect(result).not.toContain("(@electric-sql/pglite@0.5.8)");
    expect(result).toContain("        version: 0.45.4(kysely@0.29.6)\n");
    expect(result).toContain("        version: 1.7.7(drizzle-orm@0.45.4(kysely@0.29.6))\n");
    expect(result).toContain(`  drizzle-orm@0.45.4(kysely@0.29.6):
    optionalDependencies:
      kysely: 0.29.6

  kysely@0.29.6: {}
`);
    expect(result.match(/^ {2}drizzle-orm@0\.45\.4\(kysely@0\.29\.6\):$/gm)).toHaveLength(1);
    // A package whose name starts with the peer's name is a different package.
    expect(result).toContain("  '@electric-sql/pglite-tools@1.0.0':\n");
  });

  it("drops a dependency group whose only entry was the removed link", () => {
    const onlyPglite = lockfile
      .replaceAll("(kysely@0.29.6)", "")
      .replace("      '@electric-sql/pglite': 0.5.8\n      kysely: 0.29.6\n", "      '@electric-sql/pglite': 0.5.8\n")
      .replace("  drizzle-orm@0.45.4:\n    optionalDependencies:\n      kysely: 0.29.6\n\n", "");
    const result = pruneOptionalPeers(onlyPglite);

    expect(result).toContain("  drizzle-orm@0.45.4:\n\n");
    expect(result).not.toContain("'@electric-sql/pglite': 0.5.8");
  });

  it("leaves a lockfile without unneeded optional peers unchanged", () => {
    const clean = pruneOptionalPeers(lockfile);
    expect(pruneOptionalPeers(clean)).toBe(clean);
  });
});
