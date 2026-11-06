import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as clack from "@clack/prompts";

beforeEach(() => {
  vi.spyOn(clack.log, "warn").mockImplementation(() => {});
  vi.spyOn(clack.log, "message").mockImplementation(() => {});
});
import { parseCliArgs, UsageError } from "../src/cli/args.js";
import { customizeReadme, customizeRootManifest, type Provenance } from "../src/core/customize.js";
import { describePlan, type ScaffoldPlan } from "../src/core/plan.js";
import {
  applyPlugins,
  confirmPluginConsent,
  extractLockfileIntegrity,
  loadPluginFromDirectory,
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

