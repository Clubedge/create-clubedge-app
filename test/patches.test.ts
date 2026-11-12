import { describe, expect, it } from "vitest";
import { allows, unusedPatches, unusedPatchWarning } from "../src/core/patches.js";
import { temporaryDirectory, writeFiles } from "./helpers.js";

describe("allows", () => {
  it("reads exact versions, and ^ and ~ ranges on a full version", () => {
    expect(allows("4.6.5", "4.6.5")).toBe(true);
    expect(allows("4.6.7", "4.6.5")).toBe(false);
    expect(allows("^4.6.0", "4.6.5")).toBe(true);
    expect(allows("^4.6.7", "4.6.5")).toBe(false);
    expect(allows("^4.6.7", "5.0.0")).toBe(false);
    expect(allows("~4.6.0", "4.6.5")).toBe(true);
    expect(allows("~4.6.0", "4.7.0")).toBe(false);
    // ^0.x keeps the minor, ^0.0.x the whole version.
    expect(allows("^0.25.0", "0.25.9")).toBe(true);
    expect(allows("^0.25.0", "0.26.0")).toBe(false);
    expect(allows("^0.0.5", "0.0.6")).toBe(false);
  });

  it("cannot tell for any other range", () => {
    for (const range of [">=4.0.0", "4.x", "^4.6.0 || ^5.0.0", "workspace:*", "npm:zod@^4.6.0", "latest"]) {
      expect(allows(range, "4.6.5"), range).toBeUndefined();
    }
  });
});

describe("unusedPatches", () => {
  /** A workspace with a patch on zod 4.6.5 where `patches` puts it, and the web app asking for `zod`. */
  async function project(zod: string | undefined, patches: { packageJson?: Record<string, string>; yaml?: string } = {}, overrides?: Record<string, string>) {
    const dir = await temporaryDirectory();
    const pnpm = { ...(overrides ? { overrides } : {}), ...(patches.packageJson ? { patchedDependencies: patches.packageJson } : {}) };
    await writeFiles(dir, {
      "package.json": JSON.stringify({ name: "my-app", ...(Object.keys(pnpm).length ? { pnpm } : {}) }),
      "pnpm-workspace.yaml": `packages:\n  - "apps/*"\n${patches.yaml ?? ""}`,
      "apps/web/package.json": JSON.stringify({ name: "@app/web", dependencies: { react: "^19.3.0", ...(zod ? { zod } : {}) } }),
    });
    return dir;
  }

  it("finds a patch in package.json made for a version the project no longer asks for", async () => {
    const root = await project("^4.6.7", { packageJson: { "zod@4.6.5": "patches/zod@4.6.5.patch" } });
    expect(await unusedPatches(root)).toEqual([
      { key: "zod@4.6.5", name: "zod", version: "4.6.5", patch: "patches/zod@4.6.5.patch", file: "package.json", ranges: ["^4.6.7"] },
    ]);
  });

  it("reads pnpm-workspace.yaml, with quoted and scoped keys", async () => {
    const yaml = "patchedDependencies:\n  zod@4.6.5: patches/zod@4.6.5.patch\n  '@tanstack/react-query@5.1.0': 'patches/@tanstack__react-query@5.1.0.patch'\nonlyBuiltDependencies:\n  - esbuild\n";
    const root = await project("^4.6.7", { yaml });
    await writeFiles(root, {
      "apps/api/package.json": JSON.stringify({ name: "@app/api", dependencies: { "@tanstack/react-query": "^5.2.0" } }),
    });
    expect((await unusedPatches(root)).map(({ key, file }) => [key, file])).toEqual([
      ["zod@4.6.5", "pnpm-workspace.yaml"],
      ["@tanstack/react-query@5.1.0", "pnpm-workspace.yaml"],
    ]);
  });

  it("leaves out a patch the project's range still allows, or that it cannot tell about", async () => {
    // Still allowed by a range.
    expect(await unusedPatches(await project("^4.6.0", { packageJson: { "zod@4.6.5": "patches/zod@4.6.5.patch" } }))).toEqual([]);
    // Keyed by the package alone, or by a range: pnpm applies those to any version they fit.
    expect(await unusedPatches(await project("^4.6.7", { packageJson: { zod: "p.patch", "zod@^4.6.0": "q.patch" } }))).toEqual([]);
    // A dependency of a dependency, which no package.json names.
    expect(await unusedPatches(await project(undefined, { packageJson: { "zod@4.6.5": "patches/zod@4.6.5.patch" } }))).toEqual([]);
    // A range this cannot read.
    expect(await unusedPatches(await project(">=4.6.7", { packageJson: { "zod@4.6.5": "patches/zod@4.6.5.patch" } }))).toEqual([]);
  });

  it("takes an override's range over the packages'", async () => {
    const patched = { packageJson: { "zod@4.6.5": "patches/zod@4.6.5.patch" } };
    expect(await unusedPatches(await project("^4.6.7", patched, { zod: "4.6.5" }))).toEqual([]);
    expect(await unusedPatches(await project("^4.6.0", patched, { zod: "4.6.7" }))).toHaveLength(1);
  });
});

describe("unusedPatchWarning", () => {
  const patch = (file: string, name = "zod") => ({ key: `${name}@4.6.5`, name, version: "4.6.5", patch: `patches/${name}@4.6.5.patch`, file, ranges: ["^4.6.7"] });

  it("names each patch and the range that leaves it out, and shows the key by package in its file's syntax", () => {
    expect(unusedPatchWarning([patch("package.json")], true)).toBe(
      [
        "Skipped `pnpm install`: it would stop on a patch made for a version the change moves away from (ERR_PNPM_UNUSED_PATCH):",
        "  zod@4.6.5 (patches/zod@4.6.5.patch, in package.json): the project now asks for zod ^4.6.7",
        'To try it on the new version, key it by the package alone in package.json, as `"zod": "patches/zod@4.6.5.patch"`: pnpm then applies it to the version it installs, and says so if it no longer fits. Or make it again with `pnpm patch zod`. Then run `pnpm install`.',
      ].join("\n"),
    );
    expect(unusedPatchWarning([patch("pnpm-workspace.yaml", "@scope/pkg")], false)).toContain(
      "`pnpm install` will stop on a patch made for a version the change moves away from",
    );
    expect(unusedPatchWarning([patch("pnpm-workspace.yaml", "@scope/pkg")], false)).toContain("as `'@scope/pkg': patches/@scope/pkg@4.6.5.patch`");
  });
});
