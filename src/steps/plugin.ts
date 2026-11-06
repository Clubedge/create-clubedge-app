import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { confirm, isCancel, log } from "@clack/prompts";
import { UsageError } from "../cli/args.js";
import { pathExists } from "../utils/fs.js";
import { resolvePnpm } from "./install.js";
import { run, runCapture } from "../utils/process.js";

export interface PluginContext {
  stacks: Record<string, string>;
  modules: Record<string, string>;
  apps: { web?: string; api?: string };
  starterRef: string;
  cliVersion: string;
}

export interface PluginApi {
  context: PluginContext;
  read(path: string): Promise<string>;
  write(path: string, content: string): void;
  updateJson(path: string, updater: (json: any) => any): Promise<void> | void;
  addDependency(name: string, version: string, options?: { dev?: boolean; app?: string }): void;
  addScript(name: string, command: string, options?: { app?: string }): void;
  addEnv(name: string, value: string, options?: { app?: string }): void;
}

export interface PluginRecord {
  name: string;
  version: string;
  integrity: string;
}

export interface PluginChanges {
  writes: Array<{ path: string; content: string }>;
  dependencies: Array<{ name: string; version: string; dev?: boolean; app?: string }>;
  scripts: Array<{ name: string; command: string; app?: string }>;
  envs: Array<{ name: string; value: string; app?: string }>;
}

export interface PluginManifest {
  name: string;
  version: string;
  clubedge?: {
    plugin?: string;
    pluginApi?: number;
    requires?: {
      stacks?: Record<string, string>;
      modules?: Record<string, string>;
    };
  };
}

export interface Plugin {
  apply(api: PluginApi, context: PluginContext): Promise<void> | void;
}

export function validatePluginSpec(spec: string): string {
  const at = spec.lastIndexOf("@");
  if (at <= 0) {
    throw new UsageError(
      `Invalid plugin "${spec}". Expected <package>@<version>, for example: @scope/plugin@1.2.3 or plugin@1.2.3.`,
    );
  }
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);

  if (!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) {
    throw new UsageError(`Invalid plugin package name "${name}" in "${spec}".`);
  }

  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new UsageError(
      `Plugin "${spec}" must be pinned to an exact version (e.g. ${name}@1.0.0). Ranges and "latest" are rejected.`,
    );
  }

  return spec;
}

export type PublisherFetcher = (spec: string) => Promise<string>;

export async function defaultPublisherFetcher(spec: string): Promise<string> {
  try {
    const output = await runCapture("npm", ["view", spec, "_npmUser.name", "--json"]);
    return JSON.parse(output.trim()) || "unknown";
  } catch {
    return "unknown";
  }
}

export type ConsentPrompter = (message: string) => Promise<boolean | symbol>;

export async function confirmPluginConsent(
  plugins: string[],
  yes: boolean,
  fetchPublisher: PublisherFetcher = defaultPublisherFetcher,
  askConsent: ConsentPrompter = (message) => confirm({ message, initialValue: true }),
): Promise<void> {
  const details = await Promise.all(
    plugins.map(async (spec) => ({ spec, pub: await fetchPublisher(spec) })),
  );

  if (yes) {
    for (const { spec, pub } of details) {
      log.warn(`Running third-party plugin ${spec} (published by ${pub})`);
    }
    return;
  }

  log.message(
    `Plugins execute third-party code with project access:\n` +
      details.map(({ spec, pub }) => `  • ${spec} (published by ${pub})`).join("\n"),
  );

  const ok = await askConsent("Install and run these plugins?");
  if (!ok || isCancel(ok)) {
    throw new UsageError("Plugin execution cancelled.");
  }
}

export async function extractLockfileIntegrity(tempDir: string, name: string, version?: string): Promise<string> {
  const npmLockPath = join(tempDir, "package-lock.json");
  if (await pathExists(npmLockPath)) {
    try {
      const lock = JSON.parse(await readFile(npmLockPath, "utf8"));
      const pkg = lock.packages?.[`node_modules/${name}`] ?? lock.packages?.[name];
      if (pkg?.integrity) return pkg.integrity;
    } catch {}
  }

  const pnpmLockPath = join(tempDir, "pnpm-lock.yaml");
  if (await pathExists(pnpmLockPath)) {
    try {
      const content = await readFile(pnpmLockPath, "utf8");
      const key = version ? `${name}@${version}` : name;
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = content.match(new RegExp(`${escaped}[^:]*:[\\s\\S]*?integrity:\\s*['"]?([^\\s'",}]+)`));
      if (match?.[1]) return match[1];
    } catch {}
  }

  return "unknown";
}

export async function loadPluginFromDirectory(
  pkgDir: string,
  specName: string,
  context: PluginContext,
): Promise<{ entryPath: string; manifest: PluginManifest }> {
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!(await pathExists(pkgJsonPath))) {
    throw new UsageError(`Plugin package "${specName}" is missing a package.json.`);
  }
  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(await readFile(pkgJsonPath, "utf8"));
  } catch (error) {
    throw new UsageError(`Plugin package "${specName}" has invalid package.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  const clubedge = manifest.clubedge;
  if (!clubedge || typeof clubedge.plugin !== "string" || !clubedge.plugin.trim()) {
    throw new UsageError(`Plugin "${specName}" does not declare "clubedge.plugin" in its package.json.`);
  }

  if (clubedge.pluginApi !== 1) {
    throw new UsageError(`Plugin "${specName}" specifies unsupported pluginApi ${clubedge.pluginApi} (supported: 1).`);
  }

  if (clubedge.requires?.stacks) {
    for (const [slot, expected] of Object.entries(clubedge.requires.stacks)) {
      const actual = context.stacks[slot];
      if (actual !== expected) {
        throw new UsageError(`Plugin "${specName}" requires stack ${slot}="${expected}", but project uses "${actual ?? "none"}".`);
      }
    }
  }

  if (clubedge.requires?.modules) {
    for (const [mod, expected] of Object.entries(clubedge.requires.modules)) {
      const actual = context.modules[mod];
      if (actual !== expected) {
        throw new UsageError(`Plugin "${specName}" requires module ${mod}="${expected}", but project uses "${actual ?? "none"}".`);
      }
    }
  }

  const entryPath = resolve(pkgDir, clubedge.plugin);
  if (!(await pathExists(entryPath))) {
    throw new UsageError(`Plugin "${specName}" entry "${clubedge.plugin}" was not found.`);
  }

  return { entryPath, manifest };
}

const runnerCode = `
import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { entryPath, projectDir, context } = JSON.parse(input);

function safePath(p) {
  if (typeof p !== "string" || !p.trim()) throw new Error("Invalid path: " + p);
  if (isAbsolute(p)) throw new Error("Path must be relative: " + p);
  const resolved = resolve(projectDir, p);
  const rel = relative(projectDir, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path escapes project directory: " + p);
  return resolved;
}

const writes = [];
const dependencies = [];
const scripts = [];
const envs = [];

const api = {
  context,
  async read(p) {
    const target = safePath(p);
    const rel = relative(projectDir, target).replace(/\\\\/g, "/");
    const pending = writes.find((w) => w.path === rel);
    if (pending) return pending.content;
    return await readFile(target, "utf8");
  },
  write(p, content) {
    const target = safePath(p);
    const rel = relative(projectDir, target).replace(/\\\\/g, "/");
    const existing = writes.find((w) => w.path === rel);
    if (existing) existing.content = String(content);
    else writes.push({ path: rel, content: String(content) });
  },
  async updateJson(p, updater) {
    const target = safePath(p);
    const rel = relative(projectDir, target).replace(/\\\\/g, "/");
    const existing = writes.find((w) => w.path === rel);
    const raw = existing ? existing.content : await readFile(target, "utf8");
    const json = JSON.parse(raw);
    const updated = (await updater(json)) ?? json;
    const content = JSON.stringify(updated, null, 2) + "\\n";
    if (existing) existing.content = content;
    else writes.push({ path: rel, content });
  },
  addDependency(name, version, options = {}) {
    dependencies.push({ name, version, ...options });
  },
  addScript(name, command, options = {}) {
    scripts.push({ name, command, ...options });
  },
  addEnv(name, value, options = {}) {
    envs.push({ name, value, ...options });
  },
};

const module = await import(pathToFileURL(entryPath).href);
if (typeof module.apply !== "function") throw new Error("Plugin does not export an apply function.");
await module.apply(api, context);

process.stdout.write(JSON.stringify({ writes, dependencies, scripts, envs }));
`;

export async function runPluginSandbox(
  entryPath: string,
  pkgDir: string,
  projectDir: string,
  context: PluginContext,
): Promise<PluginChanges> {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = [
      "--permission",
      `--allow-fs-read=${projectDir}`,
      `--allow-fs-read=${pkgDir}`,
      `--allow-fs-write=${projectDir}`,
      "--input-type=module",
      "-e",
      runnerCode,
    ];

    const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) {
        return rejectPromise(new Error(stderr.trim() || `Plugin process exited with code ${code}`));
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch (err) {
        rejectPromise(new Error(`Failed to parse plugin output: ${String(err)}`));
      }
    });

    child.stdin.end(JSON.stringify({ entryPath, projectDir, context }));
  });
}

function assertSafePath(projectDir: string, relativePath: string): string {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new UsageError(`Invalid relative path: "${relativePath}"`);
  }
  const resolved = resolve(projectDir, relativePath);
  const rel = relative(projectDir, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new UsageError(`Plugin path escapes project directory: "${relativePath}"`);
  }
  return resolved;
}

export async function applyPluginChanges(
  projectDir: string,
  changes: PluginChanges,
  dryRun = false,
): Promise<string[]> {
  const lines: string[] = [];

  for (const { path, content } of changes.writes) {
    const fullPath = assertSafePath(projectDir, path);
    lines.push(`write ${path}`);
    if (!dryRun) {
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content);
    }
  }

  for (const dep of changes.dependencies) {
    if (dep.app) assertSafePath(projectDir, dep.app);
    const targetFile = dep.app ? resolve(projectDir, dep.app, "package.json") : resolve(projectDir, "package.json");
    lines.push(`dependency ${dep.name}@${dep.version}${dep.dev ? " (dev)" : ""}${dep.app ? ` in ${dep.app}` : ""}`);
    if (!dryRun && (await pathExists(targetFile))) {
      try {
        const pkg = JSON.parse(await readFile(targetFile, "utf8"));
        const key = dep.dev ? "devDependencies" : "dependencies";
        pkg[key] = { ...(pkg[key] ?? {}), [dep.name]: dep.version };
        await writeFile(targetFile, `${JSON.stringify(pkg, null, 2)}\n`);
      } catch {}
    }
  }

  for (const scr of changes.scripts) {
    if (scr.app) assertSafePath(projectDir, scr.app);
    const targetFile = scr.app ? resolve(projectDir, scr.app, "package.json") : resolve(projectDir, "package.json");
    lines.push(`script "${scr.name}": "${scr.command}"${scr.app ? ` in ${scr.app}` : ""}`);
    if (!dryRun && (await pathExists(targetFile))) {
      try {
        const pkg = JSON.parse(await readFile(targetFile, "utf8"));
        pkg.scripts = { ...(pkg.scripts ?? {}), [scr.name]: scr.command };
        await writeFile(targetFile, `${JSON.stringify(pkg, null, 2)}\n`);
      } catch {}
    }
  }

  for (const env of changes.envs) {
    if (env.app) assertSafePath(projectDir, env.app);
    if (/[\r\n]/.test(env.name) || /[\r\n]/.test(env.value)) {
      throw new UsageError(`Invalid environment variable "${env.name}": must not contain newlines.`);
    }
    const targetFile = env.app ? resolve(projectDir, env.app, ".env") : resolve(projectDir, ".env");
    lines.push(`env ${env.name}=${env.value}${env.app ? ` in ${env.app}` : ""}`);
    if (!dryRun) {
      await mkdir(dirname(targetFile), { recursive: true });
      let content = "";
      if (await pathExists(targetFile)) {
        content = await readFile(targetFile, "utf8");
      }
      const line = `${env.name}=${env.value}\n`;
      if (!content.includes(`${env.name}=`)) {
        await writeFile(targetFile, content + (content.endsWith("\n") || !content ? "" : "\n") + line);
      }
    }
  }

  return lines;
}

export type PluginInstaller = (tempDir: string, plugins: string[]) => Promise<void>;

export async function defaultPluginInstaller(tempDir: string, plugins: string[]): Promise<void> {
  const pnpm = await resolvePnpm();
  if (pnpm) {
    await run(pnpm[0]!, [...pnpm.slice(1), "add", "--ignore-scripts", ...plugins], tempDir, "ignore");
  } else {
    await run("npm", ["install", "--ignore-scripts", ...plugins], tempDir, "ignore");
  }
}

async function recordPluginsInManifest(directory: string, plugins: PluginRecord[]): Promise<void> {
  const manifestPath = join(directory, "package.json");
  if (!(await pathExists(manifestPath))) return;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!manifest.clubedge || typeof manifest.clubedge !== "object") manifest.clubedge = {};
    manifest.clubedge.plugins = plugins;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch {}
}

export interface ApplyPluginsOptions {
  yes?: boolean;
  dryRun?: boolean;
  installer?: PluginInstaller;
  fetchPublisher?: PublisherFetcher;
  askConsent?: ConsentPrompter;
}

export async function applyPlugins(
  plugins: string[],
  projectDir: string,
  context: PluginContext,
  options: ApplyPluginsOptions = {},
): Promise<{ records: PluginRecord[]; dryRunLines: string[] }> {
  if (plugins.length === 0) return { records: [], dryRunLines: [] };

  const {
    yes = false,
    dryRun = false,
    installer = defaultPluginInstaller,
    fetchPublisher = defaultPublisherFetcher,
    askConsent,
  } = options;

  await confirmPluginConsent(plugins, yes, fetchPublisher, askConsent);

  const tempDir = await mkdtemp(join(tmpdir(), "clubedge-plugins-"));
  const cleanup = () =>
    rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);

  try {
    await writeFile(join(tempDir, "package.json"), '{"private": true}\n');
    await installer(tempDir, plugins);

    const records: PluginRecord[] = [];
    const dryRunLines: string[] = [];

    for (const spec of plugins) {
      const at = spec.lastIndexOf("@");
      const name = spec.slice(0, at);
      const version = spec.slice(at + 1);
      const pkgDir = join(tempDir, "node_modules", ...name.split("/"));

      const { entryPath } = await loadPluginFromDirectory(pkgDir, spec, context);
      const integrity = await extractLockfileIntegrity(tempDir, name, version);
      records.push({ name, version, integrity });

      const changes = await runPluginSandbox(entryPath, pkgDir, projectDir, context);
      const lines = await applyPluginChanges(projectDir, changes, dryRun);
      if (lines.length > 0) {
        dryRunLines.push(`Plugin ${spec}:`);
        dryRunLines.push(...lines.map((l) => `  • ${l}`));
      }
    }

    if (!dryRun) {
      await recordPluginsInManifest(projectDir, records);
    }

    return { records, dryRunLines };
  } finally {
    await cleanup();
  }
}
