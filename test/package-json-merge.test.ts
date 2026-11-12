import { describe, expect, it } from "vitest";
import { mergePackageJsonText, mergeText, planMerge, type MergeAction } from "../src/core/merge.js";

const json = (value: unknown, indent: string | number = 2) => `${JSON.stringify(value, null, indent)}\n`;

/** Merges base -> target into current, as text. */
function merge(current: string, base: string, target: string) {
  return mergePackageJsonText(Buffer.from(current), Buffer.from(base), Buffer.from(target));
}

/** What planMerge does with a package.json the project and the Starter both changed. */
function planned(current: string, base: string, target: string, path = "apps/web/package.json") {
  const files = (content: string) => new Map([[path, Buffer.from(content)]]);
  const [action] = planMerge(files(base), files(target), files(current));
  return action as Extract<MergeAction, { kind: "merge" | "conflict" }>;
}

const scripts = (entries: Record<string, string>) => ({ name: "my-app", scripts: entries });

describe("merging package.json by key", () => {
  it("merges a script the project adds after scripts the change rewrites (#111, repro B)", () => {
    const base = scripts({ dev: "next dev", "infra:up": "docker up", "infra:logs": "docker logs" });
    const yours = scripts({ dev: "next dev", "infra:up": "docker up", "infra:logs": "docker logs", "seed:demo": "tsx demo.ts" });
    const theirs = scripts({ dev: "next dev", "infra:up": "local up", "infra:logs": "local logs" });

    expect(merge(json(yours), json(base), json(theirs))).toEqual({
      text: json(scripts({ dev: "next dev", "infra:up": "local up", "infra:logs": "local logs", "seed:demo": "tsx demo.ts" })),
      conflict: false,
    });
  });

  it("merges an override the project adds where the Starter adds one (#128), and nested objects key by key", () => {
    const base = { name: "my-app", pnpm: { overrides: { esbuild: "^0.25.0" }, onlyBuiltDependencies: ["esbuild"] } };
    const yours = { name: "my-app", pnpm: { overrides: { esbuild: "^0.25.0", "left-pad": "^1.3.0" }, onlyBuiltDependencies: ["esbuild"] } };
    const theirs = { name: "my-app", pnpm: { overrides: { esbuild: "^0.26.0", undici: "^7.0.0" }, onlyBuiltDependencies: ["esbuild"] } };

    const result = merge(json(yours), json(base), json(theirs))!;
    expect(result.conflict).toBe(false);
    // Each new key goes after the one it follows in the file that added it.
    expect(JSON.parse(result.text).pnpm.overrides).toEqual({ esbuild: "^0.26.0", undici: "^7.0.0", "left-pad": "^1.3.0" });
    expect(Object.keys(JSON.parse(result.text).pnpm.overrides)).toEqual(["esbuild", "undici", "left-pad"]);
  });

  it("wraps only the lines of a key both sides changed differently", () => {
    const deps = (next: string) => ({ name: "web", dependencies: { "@clubedge/core": "workspace:*", next, react: "^19.2.0" } });

    // An exact version stays a conflict with a range (see "versions both sides raised").
    expect(merge(json(deps("16.4.3")), json(deps("^16.4.0")), json(deps("^16.5.0")))).toEqual({
      text: [
        "{",
        '  "name": "web",',
        '  "dependencies": {',
        '    "@clubedge/core": "workspace:*",',
        "<<<<<<< yours",
        '    "next": "16.4.3",',
        "=======",
        '    "next": "^16.5.0",',
        ">>>>>>> clubedge",
        '    "react": "^19.2.0"',
        "  }",
        "}",
        "",
      ].join("\n"),
      conflict: true,
    });
  });

  it("takes a value both sides changed the same way, and keeps the commas right on both sides of a conflict", () => {
    const base = { name: "web", version: "0.1.0", dependencies: { next: "^16.4.0", react: "19.1.0" } };
    const yours = { name: "web", version: "0.1.0", dependencies: { next: "^16.5.0", react: "19.2.0" } };
    const theirs = { name: "web", version: "0.1.0", dependencies: { next: "^16.5.0", react: "19.3.0" } };

    const { text, conflict } = merge(json(yours), json(base), json(theirs))!;
    expect(conflict).toBe(true);
    expect(text).toContain('    "next": "^16.5.0",\n<<<<<<< yours\n    "react": "19.2.0"\n=======\n    "react": "19.3.0"\n>>>>>>> clubedge\n  }');
  });

  describe("versions both sides raised", () => {
    /** The merged text and whether it conflicts, for one dependency each side set. */
    const raised = (yours: string, base: string | undefined, theirs: string, key = "dependencies") => {
      const file = (version: string | undefined) => json({ name: "web", [key]: { ...(version === undefined ? {} : { pkg: version }), zod: "^4.1.0" } });
      return merge(file(yours), file(base), file(theirs))!;
    };
    const version = (result: { text: string }, key = "dependencies") => JSON.parse(result.text)[key].pkg;

    it("keeps your version when you raised it past the Starter's in the same major, as pnpm up does", () => {
      // The conflicts four of thirty upgrades from v0.26.0 stopped at, after pnpm up -r.
      for (const [yours, base, theirs] of [
        ["^10.5.0", "^10.0.3", "^10.1.4"], // nodemailer
        ["^1.7.21", "^1.7.4", "^1.7.13"], // better-auth, in two workspace packages
      ] as const) {
        const result = raised(yours, base, theirs);
        expect(result.conflict).toBe(false);
        expect(version(result)).toBe(yours);
      }
    });

    it("takes the Starter's when it raised the version past yours", () => {
      const result = raised("^16.2.0", "^16.1.0", "^16.4.3");
      expect(result).toEqual({ text: json({ name: "web", dependencies: { pkg: "^16.4.3", zod: "^4.1.0" } }), conflict: false });
    });

    it("applies to devDependencies, peerDependencies, optionalDependencies, pnpm overrides, and a dependency both sides added", () => {
      for (const key of ["devDependencies", "peerDependencies", "optionalDependencies"]) {
        expect(version(raised("^5.9.3", "^5.9.0", "^5.9.2", key), key)).toBe("^5.9.3");
      }
      const overrides = (esbuild: string) => json({ name: "my-app", pnpm: { overrides: { esbuild } } });
      const result = merge(overrides("^0.25.9"), overrides("^0.25.0"), overrides("^0.25.5"))!;
      expect(result.conflict).toBe(false);
      expect(JSON.parse(result.text).pnpm.overrides.esbuild).toBe("^0.25.9");
      // Without a base: both sides added the same dependency.
      expect(version(raised("^4.2.1", undefined, "^4.3.0"))).toBe("^4.3.0");
    });

    it("takes the higher ~ range within the same minor", () => {
      expect(version(raised("~58.0.25", "~58.0.20", "~58.0.24"))).toBe("~58.0.25");
      expect(raised("~58.0.25", "~58.0.20", "~58.1.2").conflict).toBe(true);
    });

    it("keeps the minor for ^0.x and the whole version for ^0.0.x, as their ranges do", () => {
      expect(version(raised("^0.25.9", "^0.25.0", "^0.25.5"))).toBe("^0.25.9");
      expect(raised("^0.25.9", "^0.25.0", "^0.26.1").conflict).toBe(true);
      expect(raised("^0.0.7", "^0.0.5", "^0.0.6").conflict).toBe(true);
    });

    it("stays a conflict for anything else", () => {
      for (const [yours, theirs] of [
        ["^17.0.0", "^16.5.0"], // a different major
        ["0.83.4", "0.83.2"], // exact versions, as Expo pins react-native
        ["^1.7.21", "~1.7.25"], // different operators
        ["^1.8.0-beta.1", "^1.7.21"], // a prerelease
        [">=1.7.0", "^1.7.21"],
        ["workspace:^", "workspace:*"],
        ["npm:pkg-fork@^1.2.0", "^1.1.0"],
        ["github:acme/pkg#v1.2.0", "^1.1.0"],
      ] as const) {
        expect(raised(yours, "^1.0.0", theirs).conflict, `${yours} and ${theirs}`).toBe(true);
      }
    });

    it("only takes the higher version where package.json keeps versions", () => {
      const engines = (node: string) => json({ name: "web", engines: { node }, scripts: { build: node } });
      const result = merge(engines("^22.14.0"), engines("^22.12.0"), engines("^22.13.0"))!;
      expect(result.conflict).toBe(true);
      expect(result.text.match(/^<<<<<<< yours$/gm)).toHaveLength(2);
    });

    it("leaves the merged file to install: no markers in a workspace package.json both raised", () => {
      const pkg = (betterAuth: string, more: Record<string, string> = {}) =>
        json({ name: "@clubedge/auth-better-auth", dependencies: { "better-auth": betterAuth, ...more } });
      // The Starter adds a dependency too, so the merge changes the file.
      expect(planned(pkg("^1.7.21"), pkg("^1.7.4"), pkg("^1.7.13", { zod: "^4.3.0" }), "packages/auth-better-auth/package.json")).toMatchObject({
        kind: "merge",
        content: Buffer.from(pkg("^1.7.21", { zod: "^4.3.0" })),
      });
    });
  });

  describe("removals", () => {
    const base = { name: "web", dependencies: { a: "1", b: "1", c: "1" } };

    it("removes a key the Starter removed and the project did not change", () => {
      const result = merge(json({ name: "web", dependencies: { a: "1", b: "1", c: "2" } }), json(base), json({ name: "web", dependencies: { a: "1", c: "1" } }));
      expect(result).toEqual({ text: json({ name: "web", dependencies: { a: "1", c: "2" } }), conflict: false });
    });

    it("is a conflict when the Starter removed a key the project changed", () => {
      const result = merge(json({ name: "web", dependencies: { a: "1", b: "2", c: "1" } }), json(base), json({ name: "web", dependencies: { a: "1", c: "1" } }));
      expect(result?.text).toContain('    "a": "1",\n<<<<<<< yours\n    "b": "2",\n=======\n>>>>>>> clubedge\n    "c": "1"');
    });

    it("is a conflict when the project removed a key the Starter changed", () => {
      const result = merge(json({ name: "web", dependencies: { a: "1", c: "1" } }), json(base), json({ name: "web", dependencies: { a: "1", b: "2", c: "1" } }));
      expect(result?.text).toContain('    "a": "1",\n<<<<<<< yours\n=======\n    "b": "2",\n>>>>>>> clubedge\n    "c": "1"');
    });

    it("stays removed when both removed it", () => {
      const both = { name: "web", dependencies: { a: "1", c: "1" } };
      expect(merge(json({ ...both, private: true }), json(base), json(both))).toEqual({ text: json({ ...both, private: true }), conflict: false });
    });

    it("puts the neighbor's comma in the block when the conflicted key is the last one", () => {
      const result = merge(json({ name: "web", dependencies: { a: "1", b: "1", c: "2" } }), json(base), json({ name: "web", dependencies: { a: "1", b: "1" } }));
      expect(result?.text).toContain('<<<<<<< yours\n    "b": "1",\n    "c": "2"\n=======\n    "b": "1"\n>>>>>>> clubedge');
    });
  });

  it("merges a key the Starter moves from dependencies to devDependencies", () => {
    const base = { name: "web", dependencies: { next: "^16.4.0", vitest: "^5.0.0" }, devDependencies: { typescript: "^5.9.0" } };
    const yours = { name: "web", dependencies: { next: "^16.4.0", vitest: "^5.0.0", zod: "^4.2.0" }, devDependencies: { typescript: "^5.9.0" } };
    const theirs = { name: "web", dependencies: { next: "^16.4.0" }, devDependencies: { typescript: "^5.9.0", vitest: "^5.0.0" } };

    expect(merge(json(yours), json(base), json(theirs))).toEqual({
      text: json({ name: "web", dependencies: { next: "^16.4.0", zod: "^4.2.0" }, devDependencies: { typescript: "^5.9.0", vitest: "^5.0.0" } }),
      conflict: false,
    });
  });

  it("treats arrays as single values: whoever changed one wins, and both changing it is a conflict", () => {
    const base = { name: "app", files: ["dist"] };
    expect(merge(json({ name: "app", files: ["dist"], private: true }), json(base), json({ name: "app", files: ["dist", "bin"] }))?.text).toBe(
      json({ name: "app", files: ["dist", "bin"], private: true }),
    );
    const both = merge(json({ name: "app", files: ["dist", "src"] }), json(base), json({ name: "app", files: ["dist", "bin"] }));
    expect(both?.conflict).toBe(true);
    expect(both?.text).toContain('    "dist",\n<<<<<<< yours\n    "src"\n=======\n    "bin"\n>>>>>>> clubedge\n  ]');
  });

  it("keeps the project's key order, and puts a new key after the one it follows in the Starter's file, or first", () => {
    const base = { name: "web", scripts: { dev: "a", build: "b" } };
    const yours = { scripts: { build: "b", dev: "a", lint: "eslint" }, name: "web" };
    const theirs = { description: "x", name: "web", scripts: { dev: "a", test: "vitest", build: "b" } };

    const text = merge(json(yours), json(base), json(theirs))!.text;
    expect(Object.keys(JSON.parse(text))).toEqual(["description", "scripts", "name"]);
    expect(Object.keys(JSON.parse(text).scripts)).toEqual(["build", "dev", "test", "lint"]);
  });

  it("takes the provenance in clubedge from the Starter, and keeps the project's name and version", () => {
    const base = { name: "my-app", version: "1.0.0", clubedge: { starterRef: "v1", modules: { cache: "redis" } } };
    const yours = { name: "my-app", version: "1.0.0", clubedge: { starterRef: "v1", modules: { cache: "memory" } } };
    const theirs = { name: "my-app", version: "1.0.0", clubedge: { starterRef: "v2", modules: { cache: "redis" } } };
    expect(merge(json(yours), json(base), json(theirs))).toEqual({ text: json(theirs), conflict: false });
  });

  describe("formatting", () => {
    const base = { name: "web", scripts: { dev: "a" } };
    const theirs = { name: "web", scripts: { dev: "b" } };
    const yours = { name: "web", scripts: { dev: "a" }, private: true };
    const result = { name: "web", scripts: { dev: "b" }, private: true };

    it("keeps the project's indentation: four spaces or tabs", () => {
      expect(merge(json(yours, 4), json(base), json(theirs))?.text).toBe(json(result, 4));
      expect(merge(json(yours, "\t"), json(base), json(theirs))?.text).toBe(json(result, "\t"));
    });

    it("keeps a file on one line, and a missing final newline", () => {
      expect(merge(JSON.stringify(yours), json(base), json(theirs))?.text).toBe(JSON.stringify(result));
    });

    it("keeps the project's CRLF line endings, in the merge and around a conflict", () => {
      const crlf = (text: string) => text.replace(/\n/g, "\r\n");
      expect(planned(crlf(json(yours)), json(base), json(theirs)).content.toString()).toBe(crlf(json(result)));
      const conflicted = planned(crlf(json({ name: "web", scripts: { dev: "c" } })), json(base), json(theirs));
      expect(conflicted.kind).toBe("conflict");
      expect(conflicted.content.toString()).toContain('\r\n<<<<<<< yours\r\n    "dev": "c"\r\n=======\r\n    "dev": "b"\r\n>>>>>>> clubedge\r\n');
      expect(conflicted.content.toString()).not.toMatch(/[^\r]\n/);
    });
  });

  describe("planMerge", () => {
    it("merges package.json files by key, root and workspace, and reports a conflict through the same action", () => {
      const yours = json(scripts({ dev: "next dev", lint: "eslint", "seed:demo": "tsx demo.ts" }));
      const base = json(scripts({ dev: "next dev", lint: "eslint" }));
      const theirs = json(scripts({ dev: "next dev --turbo", lint: "eslint" }));
      for (const path of ["package.json", "apps/web/package.json"]) {
        expect(planned(yours, base, theirs, path)).toMatchObject({ path, kind: "merge" });
      }
      // A file named like it, but not a package.json, still merges by line: the same edits conflict.
      expect(planned(yours, base, theirs, "docs/package.json.md").kind).toBe("conflict");
    });

    it("merges by line when a side does not parse, such as a package.json with markers from an earlier change", () => {
      const base = json(scripts({ dev: "a", lint: "b" }));
      const theirs = json(scripts({ dev: "c", lint: "b" }));
      const marked = base.replace('    "lint": "b"\n', '<<<<<<< yours\n    "lint": "mine"\n=======\n    "lint": "b"\n>>>>>>> clubedge\n');

      expect(merge(marked, base, theirs)).toBeNull();
      expect(planned(marked, base, theirs).content.toString()).toBe(mergeText(Buffer.from(marked), Buffer.from(base), Buffer.from(theirs))!.text);
    });
  });
});
