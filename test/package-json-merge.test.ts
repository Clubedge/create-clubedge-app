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

    expect(merge(json(deps("^16.4.3")), json(deps("^16.4.0")), json(deps("^16.5.0")))).toEqual({
      text: [
        "{",
        '  "name": "web",',
        '  "dependencies": {',
        '    "@clubedge/core": "workspace:*",',
        "<<<<<<< yours",
        '    "next": "^16.4.3",',
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
    const base = { name: "web", version: "0.1.0", dependencies: { next: "^16.4.0", react: "^19.1.0" } };
    const yours = { name: "web", version: "0.1.0", dependencies: { next: "^16.5.0", react: "^19.2.0" } };
    const theirs = { name: "web", version: "0.1.0", dependencies: { next: "^16.5.0", react: "^19.3.0" } };

    const { text, conflict } = merge(json(yours), json(base), json(theirs))!;
    expect(conflict).toBe(true);
    expect(text).toContain('    "next": "^16.5.0",\n<<<<<<< yours\n    "react": "^19.2.0"\n=======\n    "react": "^19.3.0"\n>>>>>>> clubedge\n  }');
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
