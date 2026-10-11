import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/args.js";
import { pickTagCommit } from "../src/core/source.js";
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
      command: { name: "create" },
      projectDirectory: "my-app",
      framework: undefined,
      modules: {},
      ref: undefined,
      templateDir: undefined,
      install: true,
      git: true,
      yes: false,
      dryRun: false,
      force: false,
      help: false,
      version: false,
    });
  });

  it("reads add and remove commands", () => {
    expect(parseCliArgs(["add", "cache", "redis", "--dry-run"])).toMatchObject({
      command: { name: "add", module: "cache", option: "redis" },
      projectDirectory: undefined,
      dryRun: true,
    });
    expect(parseCliArgs(["remove", "storage", "--force", "--no-install"])).toMatchObject({
      command: { name: "remove", module: "storage" },
      force: true,
      install: false,
    });
    expect(parseCliArgs(["./add"]).command).toEqual({ name: "create" });
  });

  it("explains malformed add and remove commands", () => {
    expect(() => parseCliArgs(["add", "cache"])).toThrow("Usage: add <module> <option>");
    expect(() => parseCliArgs(["add", "cache", "redis", "extra"])).toThrow("Usage: add <module> <option>");
    expect(() => parseCliArgs(["remove"])).toThrow("Usage: remove <module>");
    expect(() => parseCliArgs(["remove", "storage", "s3"])).toThrow("Usage: remove <module>");
    expect(() => parseCliArgs(["add", "cache", "redis", "--auth", "none"])).toThrow("only apply when creating");
  });

  it("collects module flags without judging their values", () => {
    expect(
      parseCliArgs(["app", "--auth", "none", "--storage=s3", "--cache", " memory ", "--infra", "supabase"]).modules,
    ).toEqual({ auth: "none", storage: "s3", cache: "memory", infra: "supabase" });
    expect(() => parseCliArgs(["--auth", " "])).toThrow("--auth requires an option");
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

describe("tag resolution", () => {
  const output = [
    "d93d95e3bb3366c019411d41d9f2cac9d0bb96ba\trefs/tags/v0.5.0",
    "d9375c2c3b520323ff0255ef8ec65da19251c3c1\trefs/tags/v0.5.0^{}",
    "1111111111111111111111111111111111111111\trefs/tags/v0.5.0-beta",
    "2222222222222222222222222222222222222222\trefs/tags/v0.4.0",
  ].join("\n");

  it("uses the commit an annotated tag points to", () => {
    expect(pickTagCommit(output, "v0.5.0")).toBe("d9375c2c3b520323ff0255ef8ec65da19251c3c1");
  });

  it("uses a lightweight tag's own commit and ignores tags with a shared prefix", () => {
    expect(pickTagCommit(output, "v0.4.0")).toBe("2222222222222222222222222222222222222222");
    expect(pickTagCommit(output, "v0.5")).toBeUndefined();
  });
});
