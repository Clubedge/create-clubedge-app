import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/args.js";
import { assertSupportedNode } from "../src/index.js";
import { cliVersion, starterPin } from "../src/package-info.js";
import { detectLauncher } from "../src/steps/install.js";
import { fromPackedPath, toPackedPath } from "../src/utils/fs.js";
import { displayNameFromPackageName, packageNameFromDirectory } from "../src/utils/names.js";

describe("project naming", () => {
  it("normalizes a project directory into a package name", () => {
    expect(packageNameFromDirectory("My Clubedge App")).toBe("my-clubedge-app");
    expect(packageNameFromDirectory("/projects/---")).toBe("my-app");
  });

  it("turns a package name into a readable display name", () => {
    expect(displayNameFromPackageName("my-clubedge_app")).toBe("My Clubedge App");
  });
});

describe("parseCliArgs", () => {
  it("applies defaults", () => {
    expect(parseCliArgs(["my-app"])).toEqual({
      projectDirectory: "my-app",
      ref: undefined,
      templateDir: undefined,
      install: true,
      git: true,
      yes: false,
      dryRun: false,
      help: false,
      version: false,
    });
  });

  it("reads flags, negations, and short options", () => {
    expect(
      parseCliArgs(["app", "--ref=main", "--no-install", "--no-git", "-y", "--dry-run"]),
    ).toMatchObject({ ref: "main", install: false, git: false, yes: true, dryRun: true });
    expect(parseCliArgs(["--template-dir", "../starter"]).templateDir).toBe("../starter");
    expect(parseCliArgs(["-h"]).help).toBe(true);
    expect(parseCliArgs(["-v"]).version).toBe(true);
  });

  it("rejects invalid usage with guidance", () => {
    expect(() => parseCliArgs(["--wat"])).toThrow(/Run with --help/);
    expect(() => parseCliArgs(["a", "b"])).toThrow("Only one project directory");
    expect(() => parseCliArgs(["--ref", ""])).toThrow("--ref requires");
    expect(() => parseCliArgs(["--ref", "main", "--template-dir", "x"])).toThrow("either --ref");
  });
});

describe("environment checks", () => {
  it("requires Node.js 22.12 or newer", () => {
    expect(() => assertSupportedNode("22.12.0")).not.toThrow();
    expect(() => assertSupportedNode("24.0.0")).not.toThrow();
    expect(() => assertSupportedNode("22.11.9")).toThrow("Node.js 22.12 or newer");
    expect(() => assertSupportedNode("20.18.0")).toThrow();
  });

  it("detects the launching package manager", () => {
    expect(detectLauncher("npm/10.8.2 node/v22.12.0 win32 x64")).toBe("npm");
    expect(detectLauncher("pnpm/10.9.0 npm/? node/v22.12.0")).toBe("pnpm");
    expect(detectLauncher("")).toBeNull();
    expect(detectLauncher("something-else/1.0")).toBeNull();
  });
});

describe("packed file names", () => {
  it("round-trips names npm would drop from a tarball", () => {
    expect(toPackedPath(".gitignore")).toBe("_gitignore");
    expect(toPackedPath("apps/web/.gitignore")).toBe("apps/web/_gitignore");
    expect(fromPackedPath("apps/web/_gitignore")).toBe("apps/web/.gitignore");
    expect(fromPackedPath("_npmrc")).toBe(".npmrc");
    expect(toPackedPath("README.md")).toBe("README.md");
  });
});

describe("published Starter pin", () => {
  // The website and the release workflow read this field from npm, so keep it well-formed.
  it("declares a release tag and a full commit SHA", () => {
    expect(cliVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(starterPin.starterRepository).toBe("Clubedge/clubedge-starter");
    expect(starterPin.starterRef).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(starterPin.starterCommit).toMatch(/^[0-9a-f]{40}$/);
  });
});
