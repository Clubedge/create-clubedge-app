import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as clack from "@clack/prompts";

beforeEach(() => {
  vi.spyOn(clack.log, "warn").mockImplementation(() => {});
  vi.spyOn(clack.log, "message").mockImplementation(() => {});
});
import { parseCliArgs, UsageError } from "../src/cli/args.js";
import { customizeReadme, customizeRootManifest, formatRecordedPlugin, type Provenance } from "../src/core/customize.js";
import { describePlan, type ScaffoldPlan } from "../src/core/plan.js";
import { readProject } from "../src/core/project.js";
import { showStatus } from "../src/inspect.js";
import {
  applyPluginChanges,
  applyPlugins,
  assertSafePath,
  confirmPluginConsent,
  extractLockfileIntegrity,
  loadPluginFromDirectory,
  permissionFlag,
  validatePluginSpec,
  type PluginContext,
} from "../src/steps/plugin.js";

const baseProvenance: Provenance = {
  cliVersion: "0.43.1",
  starterRepository: "Clubedge/clubedge-starter",
  starterRef: "v0.27.1",
  starterCommit: "997d71d74775352d30dc2bb25017f46ef43f4fd8",
  modules: { auth: "better-auth" },
};

const baseContext: PluginContext = {
  stacks: { framework: "next" },
  modules: { auth: "better-auth" },
  apps: { web: "apps/web" },
  starterRef: "v0.27.1",
  cliVersion: "0.43.1",
};

describe("validatePluginSpec", () => {
  it("accepts exact pinned versions for scoped and unscoped packages", () => {
    expect(validatePluginSpec("@scope/plugin@1.2.3")).toBe("@scope/plugin@1.2.3");
    expect(validatePluginSpec("my-plugin@0.1.0")).toBe("my-plugin@0.1.0");
    expect(validatePluginSpec("@clubedge/plugin-extra@2.0.0-beta.1")).toBe("@clubedge/plugin-extra@2.0.0-beta.1");
    expect(validatePluginSpec("plugin@1.0.0+20261025")).toBe("plugin@1.0.0+20261025");
  });

  it("rejects unpinned specifiers and tags like latest", () => {
    expect(() => validatePluginSpec("my-plugin")).toThrow(UsageError);
    expect(() => validatePluginSpec("@scope/my-plugin")).toThrow(UsageError);
    expect(() => validatePluginSpec("my-plugin@latest")).toThrow(UsageError);
    expect(() => validatePluginSpec("@scope/plugin@next")).toThrow(UsageError);
  });

  it("rejects version ranges and wildcards", () => {
    expect(() => validatePluginSpec("my-plugin@^1.2.3")).toThrow(UsageError);
    expect(() => validatePluginSpec("my-plugin@~1.2.3")).toThrow(UsageError);
    expect(() => validatePluginSpec("my-plugin@*")).toThrow(UsageError);
    expect(() => validatePluginSpec("my-plugin@1.x")).toThrow(UsageError);
    expect(() => validatePluginSpec("my-plugin@>=1.0.0")).toThrow(UsageError);
    expect(() => validatePluginSpec("my-plugin@1.2")).toThrow(UsageError);
  });

  it("rejects invalid package names", () => {
    expect(() => validatePluginSpec("bad name@1.0.0")).toThrow(UsageError);
    expect(() => validatePluginSpec("scope/too/deep@1.0.0")).toThrow(UsageError);
  });
});

describe("parseCliArgs with --with", () => {
  it("parses single and multiple --with flags on create", () => {
    const args1 = parseCliArgs(["my-app", "--with", "@scope/plugin@1.2.3"]);
    expect(args1.plugins).toEqual(["@scope/plugin@1.2.3"]);

    const args2 = parseCliArgs(["my-app", "--with", "plugin-a@1.0.0", "--with", "plugin-b@2.0.0"]);
    expect(args2.plugins).toEqual(["plugin-a@1.0.0", "plugin-b@2.0.0"]);

    const inline = parseCliArgs(["my-app", "--with=@scope/plugin@1.2.3"]);
    expect(inline.plugins).toEqual(["@scope/plugin@1.2.3"]);
  });

  it("rejects duplicate plugin packages", () => {
    expect(() => parseCliArgs(["my-app", "--with", "pkg@1.0.0", "--with", "pkg@2.0.0"])).toThrow(
      'The plugin "pkg" is specified more than once.',
    );
  });

  it("rejects --with on non-create commands", () => {
    expect(() => parseCliArgs(["add", "cache", "redis", "--with", "plugin@1.0.0"])).toThrow(
      "--with only applies when creating a project.",
    );
    expect(() => parseCliArgs(["remove", "storage", "--with", "plugin@1.0.0"])).toThrow(
      "--with only applies when creating a project.",
    );
    expect(() => parseCliArgs(["upgrade", "--with", "plugin@1.0.0"])).toThrow(
      "--with only applies when creating a project.",
    );
    expect(() => parseCliArgs(["status", "--with", "plugin@1.0.0"])).toThrow(
      "--with only applies when creating a project.",
    );
  });
});

describe("confirmPluginConsent", () => {
  it("warns and proceeds without prompting when yes is true", async () => {
    const warnSpy = vi.spyOn(clack.log, "warn").mockImplementation(() => {});
    const askConsent = vi.fn();

    await confirmPluginConsent(["@scope/plugin@1.2.3"], true, async () => "alice", askConsent);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Running third-party plugin @scope/plugin@1.2.3 (published by alice)"),
    );
    expect(askConsent).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("prompts for consent and cancels if user rejects", async () => {
    const askConsent = vi.fn().mockResolvedValue(false);
    const msgSpy = vi.spyOn(clack.log, "message").mockImplementation(() => {});

    await expect(
      confirmPluginConsent(["@scope/plugin@1.2.3"], false, async () => "alice", askConsent),
    ).rejects.toThrow(UsageError);

    expect(askConsent).toHaveBeenCalled();
    msgSpy.mockRestore();
  });
});

describe("loadPluginFromDirectory", () => {
  it("fails when package.json does not declare clubedge.plugin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plugin-test-"));
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test-plugin", version: "1.0.0" }));
      await expect(loadPluginFromDirectory(dir, "test-plugin@1.0.0", baseContext)).rejects.toThrow(
        'Plugin "test-plugin@1.0.0" does not declare "clubedge.plugin" in its package.json.',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses an unknown pluginApi", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plugin-test-"));
    try {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "test-plugin",
          version: "1.0.0",
          clubedge: { plugin: "./plugin.mjs", pluginApi: 2 },
        }),
      );
      await expect(loadPluginFromDirectory(dir, "test-plugin@1.0.0", baseContext)).rejects.toThrow(
        'Plugin "test-plugin@1.0.0" specifies unsupported pluginApi 2 (supported: 1).',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses an incompatible plugin whose requires does not match project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plugin-test-"));
    try {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "test-plugin",
          version: "1.0.0",
          clubedge: {
            plugin: "./plugin.mjs",
            pluginApi: 1,
            requires: { stacks: { framework: "tanstack-start" } },
          },
        }),
      );
      await expect(loadPluginFromDirectory(dir, "test-plugin@1.0.0", baseContext)).rejects.toThrow(
        'Plugin "test-plugin@1.0.0" requires stack framework="tanstack-start", but project uses "next".',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads a compatible plugin manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plugin-test-"));
    try {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "test-plugin",
          version: "1.0.0",
          clubedge: {
            plugin: "./plugin.mjs",
            pluginApi: 1,
            requires: { stacks: { framework: "next" }, modules: { auth: "better-auth" } },
          },
        }),
      );
      await writeFile(join(dir, "plugin.mjs"), "export function apply() {}\n");
      const loaded = await loadPluginFromDirectory(dir, "test-plugin@1.0.0", baseContext);
      expect(loaded.manifest.clubedge?.pluginApi).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("applyPlugins execution lifecycle & security sandbox", () => {
  it("applies plugins via scoped API, records integrity from lockfile, and commits changes", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "clubedge-project-"));
    try {
      await writeFile(
        join(projectDir, "package.json"),
        JSON.stringify({ name: "my-app", clubedge: { starterRef: "v0.27.1" } }, null, 2) + "\n",
      );

      const mockInstaller = async (tempDir: string) => {
        // Create mock lockfile
        await writeFile(
          join(tempDir, "package-lock.json"),
          JSON.stringify({
            packages: {
              "node_modules/@scope/plugin": {
                version: "1.2.3",
                integrity: "sha512-mockIntegrityHash123",
              },
            },
          }),
        );

        const pkgDir = join(tempDir, "node_modules", "@scope", "plugin");
        await mkdir(pkgDir, { recursive: true });
        await writeFile(
          join(pkgDir, "package.json"),
          JSON.stringify({
            name: "@scope/plugin",
            version: "1.2.3",
            clubedge: { plugin: "./plugin.mjs", pluginApi: 1 },
          }),
        );
        await writeFile(
          join(pkgDir, "plugin.mjs"),
          `
          export async function apply(api, ctx) {
            api.write("plugin-output.txt", "hello from scoped api");
            api.addDependency("canvas-confetti", "^1.9.0");
            api.addScript("party", "confetti");
            api.addEnv("PLUGIN_ENABLED", "true");
            await api.updateJson("package.json", (pkg) => {
              pkg.description = "customized by plugin";
              return pkg;
            });
          }
        `,
        );
      };

      const result = await applyPlugins(["@scope/plugin@1.2.3"], projectDir, baseContext, {
        yes: true,
        installer: mockInstaller,
        fetchPublisher: async () => "test-publisher",
      });

      // 1. Integrity recorded
      expect(result.records).toEqual([
        {
          name: "@scope/plugin",
          version: "1.2.3",
          integrity: "sha512-mockIntegrityHash123",
        },
      ]);
      const manifest = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8"));
      expect(manifest.clubedge.plugins).toEqual(result.records);
      expect(manifest.description).toBe("customized by plugin");
      expect(manifest.dependencies["canvas-confetti"]).toBe("^1.9.0");
      expect(manifest.scripts.party).toBe("confetti");

      // 2. File written
      const file = await readFile(join(projectDir, "plugin-output.txt"), "utf8");
      expect(file).toBe("hello from scoped api");

      // 3. Env written
      const env = await readFile(join(projectDir, ".env"), "utf8");
      expect(env).toContain("PLUGIN_ENABLED=true");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("fails when a plugin attempts to write outside the project directory", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "clubedge-project-"));
    try {
      await writeFile(join(projectDir, "package.json"), JSON.stringify({ name: "my-app" }, null, 2) + "\n");

      const mockInstaller = async (tempDir: string) => {
        const pkgDir = join(tempDir, "node_modules", "escape-plugin");
        await mkdir(pkgDir, { recursive: true });
        await writeFile(
          join(pkgDir, "package.json"),
          JSON.stringify({
            name: "escape-plugin",
            version: "1.0.0",
            clubedge: { plugin: "./plugin.mjs", pluginApi: 1 },
          }),
        );
        await writeFile(
          join(pkgDir, "plugin.mjs"),
          `
          export async function apply(api) {
            api.write("../outside.txt", "escaped content");
          }
        `,
        );
      };

      await expect(
        applyPlugins(["escape-plugin@1.0.0"], projectDir, baseContext, {
          yes: true,
          installer: mockInstaller,
          fetchPublisher: async () => "attacker",
        }),
      ).rejects.toThrow(/escapes project directory/i);
      await expect(readFile(join(projectDir, "..", "outside.txt"))).rejects.toThrow();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("leaves nothing behind when a plugin fails", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "clubedge-project-"));
    try {
      await writeFile(join(projectDir, "package.json"), JSON.stringify({ name: "my-app" }, null, 2) + "\n");

      const mockInstaller = async (tempDir: string) => {
        const pkgDir = join(tempDir, "node_modules", "failing-plugin");
        await mkdir(pkgDir, { recursive: true });
        await writeFile(
          join(pkgDir, "package.json"),
          JSON.stringify({
            name: "failing-plugin",
            version: "1.0.0",
            clubedge: { plugin: "./plugin.mjs", pluginApi: 1 },
          }),
        );
        await writeFile(
          join(pkgDir, "plugin.mjs"),
          `
          export async function apply(api) {
            api.write("partial.txt", "should not exist");
            throw new Error("Plugin exploded mid-way");
          }
        `,
        );
      };

      await expect(
        applyPlugins(["failing-plugin@1.0.0"], projectDir, baseContext, {
          yes: true,
          installer: mockInstaller,
          fetchPublisher: async () => "dev",
        }),
      ).rejects.toThrow("Plugin exploded mid-way");

      // Verify partial file was NOT written
      await expect(readFile(join(projectDir, "partial.txt"))).rejects.toThrow();
      // Verify package.json was not corrupted or given plugin provenance
      const manifest = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8"));
      expect(manifest.clubedge?.plugins).toBeUndefined();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("lists changes and writes nothing on --dry-run", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "clubedge-project-"));
    try {
      await writeFile(join(projectDir, "package.json"), JSON.stringify({ name: "my-app" }, null, 2) + "\n");

      const mockInstaller = async (tempDir: string) => {
        const pkgDir = join(tempDir, "node_modules", "dry-plugin");
        await mkdir(pkgDir, { recursive: true });
        await writeFile(
          join(pkgDir, "package.json"),
          JSON.stringify({
            name: "dry-plugin",
            version: "1.0.0",
            clubedge: { plugin: "./plugin.mjs", pluginApi: 1 },
          }),
        );
        await writeFile(
          join(pkgDir, "plugin.mjs"),
          `
          export async function apply(api) {
            api.write("dry.txt", "dry content");
            api.addDependency("dry-dep", "1.0.0");
          }
        `,
        );
      };

      const { dryRunLines } = await applyPlugins(["dry-plugin@1.0.0"], projectDir, baseContext, {
        yes: true,
        dryRun: true,
        installer: mockInstaller,
        fetchPublisher: async () => "dev",
      });

      expect(dryRunLines.length).toBeGreaterThan(0);
      expect(dryRunLines.some((l) => l.includes("write dry.txt"))).toBe(true);
      expect(dryRunLines.some((l) => l.includes("dependency dry-dep@1.0.0"))).toBe(true);

      // Verify nothing written on disk
      await expect(readFile(join(projectDir, "dry.txt"))).rejects.toThrow();
      const manifest = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8"));
      expect(manifest.dependencies?.["dry-dep"]).toBeUndefined();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe("provenance recording", () => {
  const rootManifest = JSON.stringify({ name: "template", scripts: { "docker:build": "docker build -t clubedge ." } });

  it("records plugins under package.json#clubedge.plugins when present", () => {
    const provenanceWithPlugins: Provenance = {
      ...baseProvenance,
      plugins: [{ name: "@scope/plugin", version: "1.2.3", integrity: "sha512-abc" }],
    };
    const customized = JSON.parse(
      customizeRootManifest(rootManifest, { packageName: "my-app", displayName: "My App" }, provenanceWithPlugins, "clubedge"),
    );
    expect(customized.clubedge.plugins).toEqual([
      { name: "@scope/plugin", version: "1.2.3", integrity: "sha512-abc" },
    ]);
  });

  it("omits plugins from package.json#clubedge when none are given", () => {
    const customized = JSON.parse(
      customizeRootManifest(rootManifest, { packageName: "my-app", displayName: "My App" }, baseProvenance, "clubedge"),
    );
    expect(customized.clubedge.plugins).toBeUndefined();
  });

  it("records plugins in README provenance when present and leaves untouched when absent", () => {
    const readmeSource = "# Starter\n\nREADME content\n";
    const withPlugins = customizeReadme(
      readmeSource,
      { packageName: "my-app", displayName: "My App" },
      {
        ...baseProvenance,
        plugins: [{ name: "@scope/plugin", version: "1.2.3", integrity: "sha512-abc" }],
      },
    );
    expect(withPlugins).toContain("- Plugins: @scope/plugin@1.2.3");

    const withoutPlugins = customizeReadme(
      readmeSource,
      { packageName: "my-app", displayName: "My App" },
      baseProvenance,
    );
    expect(withoutPlugins).not.toContain("Plugins:");
  });

  it("describes plugin application in describePlan", () => {
    const plan: ScaffoldPlan = {
      targetDirectory: "/tmp/my-app",
      identity: { packageName: "my-app", displayName: "My App" },
      provenance: baseProvenance,
      apps: [],
      modules: [],
      files: [],
      edits: [],
      envFiles: [],
      databaseEnvFile: null,
      toolchains: [],
      plugins: ["@scope/plugin@1.2.3"],
      git: true,
      install: true,
    };
    const lines = describePlan(plan);
    expect(lines).toContain("Apply plugin @scope/plugin@1.2.3");
  });

  it("extracts clean integrity from pnpm-lock.yaml without trailing curly brace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pnpm-lock-"));
    try {
      const pnpmLock = [
        "lockfileVersion: '9.0'",
        "importers:",
        "  .:",
        "    dependencies:",
        "      '@scope/plugin':",
        "        specifier: 1.2.3",
        "        version: 1.2.3",
        "packages:",
        "  '@scope/plugin@1.2.3':",
        "    resolution: {integrity: sha512-cleanIntegrityHash123==}",
      ].join("\n");
      await writeFile(join(dir, "pnpm-lock.yaml"), pnpmLock);
      const integrity = await extractLockfileIntegrity(dir, "@scope/plugin", "1.2.3");
      expect(integrity).toBe("sha512-cleanIntegrityHash123==");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function writeFakePluginPackage(
  root: string,
  name: string,
  version: string,
  code: string,
): Promise<string> {
  const pkgDir = join(root, ...name.split("/"));
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name, version, type: "module", clubedge: { plugin: "./index.mjs", pluginApi: 1 } }),
  );
  await writeFile(join(pkgDir, "index.mjs"), code);
  return pkgDir;
}

const fetchNoPublisher = async () => "verified";

describe("plugin security hardening and composition", () => {
  it("selects --experimental-permission on Node 22.12.x and --permission from 22.13+", () => {
    expect(permissionFlag("22.12.0")).toBe("--experimental-permission");
    expect(permissionFlag("22.12.9")).toBe("--experimental-permission");
    expect(permissionFlag("22.13.0")).toBe("--permission");
    expect(permissionFlag("22.14.1")).toBe("--permission");
    expect(permissionFlag("24.20.0")).toBe("--permission");
  });

  it("isolates plugin console output, blocks direct fs writes, and strips secret env vars", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "clubedge-hardening-"));
    const previousSecret = process.env.CLUBEDGE_TEST_SECRET_TOKEN;
    process.env.CLUBEDGE_TEST_SECRET_TOKEN = "top-secret-token";
    try {
      await writeFile(join(projectDir, "package.json"), JSON.stringify({ name: "my-app" }) + "\n");

      await applyPlugins(["@scope/noisy@1.0.0"], projectDir, { ...baseContext, apps: { web: "apps/next", custom: "packages/custom" } }, {
        yes: true,
        fetchPublisher: fetchNoPublisher,
        installer: async (tempDir) => {
          await writeFakePluginPackage(
            join(tempDir, "node_modules"),
            "@scope/noisy",
            "1.0.0",
            [
              'console.log("top-level log");',
              'export async function apply(api, context) {',
              '  console.log("apply log");',
              '  const seenSecret = process.env.CLUBEDGE_TEST_SECRET_TOKEN ?? "redacted";',
              '  api.write("result.txt", `${seenSecret}|${context.apps.custom ?? ""}`);',
              '}',
            ].join("\n"),
          );
        },
      });

      expect(await readFile(join(projectDir, "result.txt"), "utf8")).toBe("redacted|packages/custom");

      await expect(
        applyPlugins(["@scope/writer@1.0.0"], projectDir, baseContext, {
          yes: true,
          fetchPublisher: fetchNoPublisher,
          installer: async (tempDir) => {
            await writeFakePluginPackage(
              join(tempDir, "node_modules"),
              "@scope/writer",
              "1.0.0",
              [
                'import { writeFileSync } from "node:fs";',
                'import { join } from "node:path";',
                `export async function apply() { writeFileSync(join(${JSON.stringify(projectDir)}, "bypassed.txt"), "nope"); }`,
              ].join("\n"),
            );
          },
        }),
      ).rejects.toThrow();
      expect(await readFile(join(projectDir, "bypassed.txt"), "utf8").catch(() => null)).toBeNull();
    } finally {
      if (previousSecret === undefined) delete process.env.CLUBEDGE_TEST_SECRET_TOKEN;
      else process.env.CLUBEDGE_TEST_SECRET_TOKEN = previousSecret;
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("allows sandbox imports across pnpm-style symlinks/junctions", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "clubedge-pnpm-"));
    try {
      await writeFile(join(projectDir, "package.json"), JSON.stringify({ name: "my-app" }) + "\n");
      await applyPlugins(["@scope/linked@1.0.0"], projectDir, baseContext, {
        yes: true,
        fetchPublisher: fetchNoPublisher,
        installer: async (tempDir) => {
          const storePkgDir = join(tempDir, "node_modules", ".pnpm", "@scope+linked@1.0.0", "node_modules", "@scope", "linked");
          const storeHelperDir = join(tempDir, "node_modules", ".pnpm", "@scope+linked@1.0.0", "node_modules", "helper");
          await mkdir(storePkgDir, { recursive: true });
          await mkdir(storeHelperDir, { recursive: true });
          await writeFile(join(storeHelperDir, "index.mjs"), 'export const greeting = "from-pnpm-helper";\n');
          await writeFile(
            join(storePkgDir, "package.json"),
            JSON.stringify({ name: "@scope/linked", version: "1.0.0", type: "module", clubedge: { plugin: "./index.mjs", pluginApi: 1 } }),
          );
          await writeFile(
            join(storePkgDir, "index.mjs"),
            [
              'import { greeting } from "../../helper/index.mjs";',
              'export async function apply(api) { api.write("linked.txt", greeting); }',
            ].join("\n"),
          );
          await mkdir(join(tempDir, "node_modules", "@scope"), { recursive: true });
          await symlink(
            storePkgDir,
            join(tempDir, "node_modules", "@scope", "linked"),
            process.platform === "win32" ? "junction" : "dir",
          );
        },
      });
      expect(await readFile(join(projectDir, "linked.txt"), "utf8")).toBe("from-pnpm-helper");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("composes multi-plugin writes/overlays in dry-run without existing targetDir and rolls back cleanly on later failure", async () => {
    const missingBase = await mkdtemp(join(tmpdir(), "clubedge-dry-"));
    const nonexistentTarget = join(missingBase, "not-created-yet");
    const installer = async (tempDir: string) => {
      await writeFakePluginPackage(
        join(tempDir, "node_modules"),
        "@scope/first",
        "1.0.0",
        [
          "export async function apply(api) {",
          '  api.write("shared.txt", "step-1");',
          '  api.addDependency("zod", "^3.23.0");',
          '  api.addEnv("FIRST_KEY", "one");',
          "}",
        ].join("\n"),
      );
      await writeFakePluginPackage(
        join(tempDir, "node_modules"),
        "@scope/second",
        "1.0.0",
        [
          "export async function apply(api) {",
          '  const prev = await api.read("shared.txt");',
          '  const pkg = JSON.parse(await api.read("package.json"));',
          '  api.write("summary.txt", `${prev}|${pkg.dependencies.zod}`);',
          "}",
        ].join("\n"),
      );
    };

    try {
      const dry = await applyPlugins(["@scope/first@1.0.0", "@scope/second@1.0.0"], nonexistentTarget, baseContext, {
        yes: true,
        dryRun: true,
        initialFiles: { "package.json": JSON.stringify({ name: "my-app", clubedge: {} }, null, 2) + "\n" },
        installer,
        fetchPublisher: fetchNoPublisher,
      });
      expect(dry.dryRunLines.join("\n")).toContain("write summary.txt");
      expect(await readFile(join(nonexistentTarget, "shared.txt"), "utf8").catch(() => null)).toBeNull();

      // Failing second plugin in normal mode must leave zero writes on disk.
      const realDir = join(missingBase, "real-project");
      await mkdir(realDir, { recursive: true });
      const initialPkg = JSON.stringify({ name: "my-app", clubedge: {} }, null, 2) + "\n";
      await writeFile(join(realDir, "package.json"), initialPkg);

      await expect(
        applyPlugins(["@scope/first@1.0.0", "@scope/boom@1.0.0"], realDir, baseContext, {
          yes: true,
          fetchPublisher: fetchNoPublisher,
          installer: async (tempDir) => {
            await installer(tempDir);
            await writeFakePluginPackage(
              join(tempDir, "node_modules"),
              "@scope/boom",
              "1.0.0",
              'export async function apply() { throw new Error("second failed"); }',
            );
          },
        }),
      ).rejects.toThrow("second failed");
      expect(await readFile(join(realDir, "shared.txt"), "utf8").catch(() => null)).toBeNull();
      expect(await readFile(join(realDir, "package.json"), "utf8")).toBe(initialPkg);

      // Succeeding second plugin persists composed changes from first plugin too.
      await applyPlugins(["@scope/first@1.0.0", "@scope/second@1.0.0"], realDir, baseContext, {
        yes: true,
        installer,
        fetchPublisher: fetchNoPublisher,
      });
      expect(await readFile(join(realDir, "summary.txt"), "utf8")).toBe("step-1|^3.23.0");
      expect(await readFile(join(realDir, ".env"), "utf8")).toBe("FIRST_KEY=one\n");
    } finally {
      await rm(missingBase, { recursive: true, force: true });
    }
  });

  it("validates parent paths, blocks prototype pollution, and matches .env keys per line", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "clubedge-validate-"));
    try {
      await writeFile(join(projectDir, "package.json"), JSON.stringify({ name: "my-app" }) + "\n");
      await writeFile(join(projectDir, ".env"), "MY_FOO_BAR=1\nexport EXISTING=keep\n");

      expect(() => assertSafePath(projectDir, "/etc/passwd")).toThrow(UsageError);
      expect(() => assertSafePath(projectDir, "bad\0path")).toThrow(UsageError);
      expect(() => assertSafePath(projectDir, ".")).toThrow(UsageError);
      expect(() => assertSafePath(projectDir, ".", true)).not.toThrow();

      await applyPluginChanges(projectDir, {
        writes: [],
        dependencies: [],
        scripts: [],
        envs: [
          { name: "FOO_BAR", value: "2" },
          { name: "EXISTING", value: "overwrite-attempt" },
        ],
      });
      const envContent = await readFile(join(projectDir, ".env"), "utf8");
      expect(envContent).toContain("FOO_BAR=2");
      expect(envContent).toContain("export EXISTING=keep");
      expect(envContent).not.toContain("overwrite-attempt");

      await expect(
        applyPluginChanges(projectDir, {
          writes: [],
          dependencies: [],
          scripts: [],
          envs: [{ name: "BAD=KEY", value: "1" }],
        }),
      ).rejects.toThrow(UsageError);

      await expect(
        applyPluginChanges(projectDir, {
          writes: [],
          dependencies: [{ name: "__proto__", version: "1.0.0" }],
          scripts: [],
          envs: [],
        }),
      ).rejects.toThrow(UsageError);

      await expect(
        applyPluginChanges(projectDir, {
          writes: [],
          dependencies: [],
          scripts: [{ name: "constructor", command: "evil" }],
          envs: [],
        }),
      ).rejects.toThrow(UsageError);

      await writeFile(join(projectDir, "package.json"), "{not-json");
      await expect(
        applyPluginChanges(projectDir, {
          writes: [],
          dependencies: [{ name: "zod", version: "3.0.0" }],
          scripts: [],
          envs: [],
        }),
      ).rejects.toThrow(UsageError);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("avoids cross-package bleed and prefix collisions in pnpm-lock.yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pnpm-lock-edge-"));
    try {
      const noBleed = [
        "lockfileVersion: '9.0'",
        "importers:",
        "  .:",
        "    dependencies:",
        "      '@scope/plugin':",
        "        version: 1.2.3",
        "packages:",
        "  '@scope/plugin@1.2.30':",
        "    resolution: {integrity: sha512-wrongPrefix==}",
        "  '@scope/plugin@1.2.3':",
        "    resolution: {directory: ../local}",
        "  '@scope/other@2.0.0':",
        "    resolution: {integrity: sha512-nextPackageBleed==}",
        "snapshots:",
        "  '@scope/plugin@1.2.3':",
        "    resolution: {integrity: sha512-snapshotWrong==}",
      ].join("\n");
      await writeFile(join(dir, "pnpm-lock.yaml"), noBleed);
      expect(await extractLockfileIntegrity(dir, "@scope/plugin", "1.2.3")).toBe("unknown");

      const exact = noBleed.replace(
        "  '@scope/plugin@1.2.3':\n    resolution: {directory: ../local}",
        "  '/@scope/plugin@1.2.3(react@18.3.1)':\n    resolution: {integrity: sha512-exactPeerHash==}",
      );
      await writeFile(join(dir, "pnpm-lock.yaml"), exact);
      expect(await extractLockfileIntegrity(dir, "@scope/plugin", "1.2.3")).toBe("sha512-exactPeerHash==");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("filters malformed clubedge.plugins entries in readProject, customizeReadme, and showStatus", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "clubedge-malformed-plugins-"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const messageSpy = vi.spyOn(clack.log, "message");
    try {
      await writeFile(
        join(projectDir, "package.json"),
        JSON.stringify({
          name: "my-app",
          clubedge: {
            cliVersion: "0.47.0",
            starterRepository: "Clubedge/clubedge-starter",
            starterRef: "v0.27.1",
            framework: "next",
            modules: { auth: "better-auth" },
            plugins: [
              null,
              123,
              { name: "@scope/missing-version" },
              { name: "@scope/valid", version: "1.2.3", integrity: "sha512-ok==" },
              "@scope/legacy@0.9.0",
            ],
          },
        }),
      );

      expect(formatRecordedPlugin(null)).toBeNull();
      expect(formatRecordedPlugin({ name: "only-name" })).toBeNull();
      expect(formatRecordedPlugin("@scope/legacy@0.9.0")).toBe("@scope/legacy@0.9.0");

      const project = await readProject(projectDir);
      expect(project?.plugins).toEqual([
        { name: "@scope/valid", version: "1.2.3", integrity: "sha512-ok==" },
        "@scope/legacy@0.9.0",
      ]);

      const readme = customizeReadme("# Readme\n", { packageName: "my-app", displayName: "My App" }, {
        ...baseProvenance,
        plugins: [null as never, { name: "@scope/valid", version: "1.2.3", integrity: "sha512-ok==" }],
      });
      expect(readme).toContain("- Plugins: @scope/valid@1.2.3");
      expect(readme).not.toContain("undefined");

      await showStatus(parseCliArgs(["status"]));
      const output = messageSpy.mock.calls.at(-1)?.[0] as string;
      expect(output).toContain("Plugins");
      expect(output).toContain("@scope/valid@1.2.3, @scope/legacy@0.9.0");
      expect(output).not.toContain("undefined");

      await writeFile(
        join(projectDir, "package.json"),
        JSON.stringify({
          name: "my-app",
          clubedge: {
            cliVersion: "0.47.0",
            starterRepository: "Clubedge/clubedge-starter",
            starterRef: "v0.27.1",
            framework: "next",
            modules: { auth: "better-auth" },
            plugins: [null, { name: "@scope/missing-version" }],
          },
        }),
      );
      expect((await readProject(projectDir))?.plugins).toBeUndefined();
    } finally {
      stdoutSpy.mockRestore();
      fetchSpy.mockRestore();
      cwdSpy.mockRestore();
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
