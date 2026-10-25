import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  apps: { web?: string; api?: string; [slot: string]: string | undefined };
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function assertSafePath(projectDir: string, relativePath: string, allowRoot = false): string {
  if (typeof relativePath !== "string" || !relativePath.trim() || relativePath.includes("\0")) {
    throw new UsageError(`Invalid relative path: "${relativePath}"`);
  }
  if (isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) {
    throw new UsageError(`Plugin path must be relative: "${relativePath}"`);
  }
  const resolved = resolve(projectDir, relativePath);
  const rel = relative(projectDir, resolved);
  if ((!allowRoot && rel === "") || rel.startsWith("..") || isAbsolute(rel)) {
    throw new UsageError(`Plugin path escapes project directory: "${relativePath}"`);
  }
  return resolved;
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
      const specPattern = version
        ? `${escapeRegex(`${name}@${version}`)}(?:\\(.*\\))?`
        : `${escapeRegex(name)}@[^\\s('":]+`;
      const entryRe = new RegExp(`^  ['"]?/?${specPattern}['"]?:\\s*(?:#.*)?$`);
      let inPackages = false;
      let inEntry = false;
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        if (/^[^\s#]/.test(line)) {
          inPackages = /^packages:\s*(?:#.*)?$/.test(line);
          inEntry = false;
          continue;
        }
        if (!inPackages) continue;
        if (/^  [^\s#]/.test(line)) {
          inEntry = entryRe.test(line);
          continue;
        }
        if (inEntry) {
          const match = line.match(/\bintegrity:\s*['"]?([^\s'",}]+)/);
          if (match?.[1]) return match[1];
        }
      }
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

  const entryPath = assertSafePath(pkgDir, clubedge.plugin);
  if (!(await pathExists(entryPath))) {
    throw new UsageError(`Plugin "${specName}" entry "${clubedge.plugin}" was not found.`);
  }

  return { entryPath, manifest };
}

const runnerCode = `
import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const writeResult = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { entryPath, projectDir, context, overlay = {} } = JSON.parse(input);

function safePath(p) {
  if (typeof p !== "string" || !p.trim() || p.includes("\\0")) throw new Error("Invalid path: " + p);
  if (isAbsolute(p) || /^[A-Za-z]:/.test(p)) throw new Error("Path must be relative: " + p);
  const resolved = resolve(projectDir, p);
  const rel = relative(projectDir, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path escapes project directory: " + p);
  return { resolved, rel: rel.replace(/\\\\/g, "/") };
}

const writes = [];
const dependencies = [];
const scripts = [];
const envs = [];

const api = {
  context,
  async read(p) {
    const { resolved, rel } = safePath(p);
    const pending = writes.find((w) => w.path === rel);
    if (pending) return pending.content;
    if (Object.hasOwn(overlay, rel)) return overlay[rel];
    return await readFile(resolved, "utf8");
  },
  write(p, content) {
    const { rel } = safePath(p);
    const existing = writes.find((w) => w.path === rel);
    if (existing) existing.content = String(content);
    else writes.push({ path: rel, content: String(content) });
  },
  async updateJson(p, updater) {
    const { resolved, rel } = safePath(p);
    const existing = writes.find((w) => w.path === rel);
    const raw = existing
      ? existing.content
      : Object.hasOwn(overlay, rel)
        ? overlay[rel]
        : await readFile(resolved, "utf8");
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

await new Promise((resolveWrite) => writeResult(JSON.stringify({ writes, dependencies, scripts, envs }), resolveWrite));
`;

export function permissionFlag(nodeVersion = process.versions.node): string {
  const [major = 0, minor = 0] = nodeVersion.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13) ? "--permission" : "--experimental-permission";
}

const SANDBOX_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "HOME",
  "USERPROFILE",
  "TMP",
  "TEMP",
  "TMPDIR",
] as const;

function sandboxEnv(): Record<string, string> {
  const env: Record<string, string> = { NODE_NO_WARNINGS: "1" };
  for (const key of SANDBOX_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export interface SandboxOptions {
  installRoot?: string;
  overlay?: Record<string, string>;
}

export async function runPluginSandbox(
  entryPath: string,
  pkgDir: string,
  projectDir: string,
  context: PluginContext,
  options: SandboxOptions = {},
): Promise<PluginChanges> {
  const realEntryPath = await realpath(entryPath);
  const realPkgDir = await realpath(pkgDir);
  const realInstallRoot = options.installRoot ? await realpath(options.installRoot) : realPkgDir;
  const realProjectDir = await realpath(projectDir).catch(() => null);

  const readPaths = new Set<string>([realPkgDir, realInstallRoot]);
  if (realProjectDir) readPaths.add(realProjectDir);

  return new Promise((resolvePromise, rejectPromise) => {
    const args = [
      permissionFlag(),
      ...Array.from(readPaths, (dir) => `--allow-fs-read=${dir}`),
      "--input-type=module",
      "-e",
      runnerCode,
    ];

    const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], env: sandboxEnv() });
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
        resolvePromise(parsePluginChanges(JSON.parse(stdout)));
      } catch (err) {
        rejectPromise(err instanceof UsageError ? err : new Error(`Failed to parse plugin output: ${String(err)}`));
      }
    });

    child.stdin.end(
      JSON.stringify({
        entryPath: realEntryPath,
        projectDir: realProjectDir ?? resolve(projectDir),
        context,
        overlay: options.overlay ?? {},
      }),
    );
  });
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertSafeKey(kind: string, key: string): void {
  if (!key || UNSAFE_KEYS.has(key)) {
    throw new UsageError(`Invalid ${kind} name: "${key}"`);
  }
}

function relativeToProject(projectDir: string, fullPath: string): string {
  return relative(projectDir, fullPath).replace(/\\/g, "/");
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function parsePluginChanges(raw: unknown): PluginChanges {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UsageError("Plugin returned malformed output.");
  }
  const obj = raw as Record<string, unknown>;
  const asArray = (key: keyof PluginChanges) => {
    const val = obj[key];
    if (!Array.isArray(val)) throw new UsageError(`Plugin output "${key}" must be an array.`);
    return val;
  };

  const writes = asArray("writes").map((w) => {
    const item = w as { path?: unknown; content?: unknown };
    if (!w || typeof w !== "object" || typeof item.path !== "string" || typeof item.content !== "string") {
      throw new UsageError("Plugin write entry must include string path and content.");
    }
    return { path: item.path, content: item.content };
  });

  const dependencies = asArray("dependencies").map((d) => {
    const item = d as { name?: unknown; version?: unknown; dev?: unknown; app?: unknown };
    if (
      !d ||
      typeof d !== "object" ||
      typeof item.name !== "string" ||
      typeof item.version !== "string" ||
      (item.dev !== undefined && typeof item.dev !== "boolean") ||
      !isOptionalString(item.app)
    ) {
      throw new UsageError("Plugin dependency entry is invalid.");
    }
    return {
      name: item.name,
      version: item.version,
      ...(item.dev !== undefined ? { dev: item.dev } : {}),
      ...(item.app !== undefined ? { app: item.app } : {}),
    };
  });

  const scripts = asArray("scripts").map((s) => {
    const item = s as { name?: unknown; command?: unknown; app?: unknown };
    if (!s || typeof s !== "object" || typeof item.name !== "string" || typeof item.command !== "string" || !isOptionalString(item.app)) {
      throw new UsageError("Plugin script entry is invalid.");
    }
    return { name: item.name, command: item.command, ...(item.app !== undefined ? { app: item.app } : {}) };
  });

  const envs = asArray("envs").map((e) => {
    const item = e as { name?: unknown; value?: unknown; app?: unknown };
    if (!e || typeof e !== "object" || typeof item.name !== "string" || typeof item.value !== "string" || !isOptionalString(item.app)) {
      throw new UsageError("Plugin env entry is invalid.");
    }
    return { name: item.name, value: item.value, ...(item.app !== undefined ? { app: item.app } : {}) };
  });

  return { writes, dependencies, scripts, envs };
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`Invalid JSON in ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError(`Expected JSON object in ${label}.`);
  }
  return parsed as Record<string, unknown>;
}

async function readOverlayOrDisk(
  projectDir: string,
  rel: string,
  overlay: Map<string, string>,
): Promise<string | null> {
  if (overlay.has(rel)) return overlay.get(rel)!;
  const fullPath = assertSafePath(projectDir, rel);
  try {
    return await readFile(fullPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function setPackageJsonEntry(
  projectDir: string,
  app: string | undefined,
  section: "dependencies" | "devDependencies" | "scripts",
  name: string,
  value: string,
  overlay: Map<string, string>,
  dirty: Set<string>,
): Promise<void> {
  const appDir = app ? assertSafePath(projectDir, app, true) : projectDir;
  const rel = relativeToProject(projectDir, join(appDir, "package.json"));
  const raw = await readOverlayOrDisk(projectDir, rel, overlay);
  if (raw === null) return;
  const pkg = parseJsonObject(raw, rel);
  const existing = pkg[section];
  if (existing !== undefined && (!existing || typeof existing !== "object" || Array.isArray(existing))) {
    throw new UsageError(`Expected "${section}" to be an object in ${rel}.`);
  }
  pkg[section] = { ...(existing as Record<string, string> | undefined), [name]: value };
  overlay.set(rel, `${JSON.stringify(pkg, null, 2)}\n`);
  dirty.add(rel);
}

async function stagePluginChanges(
  projectDir: string,
  changes: PluginChanges,
  overlay: Map<string, string>,
  dirty: Set<string>,
): Promise<string[]> {
  const lines: string[] = [];

  for (const { path, content } of changes.writes) {
    const fullPath = assertSafePath(projectDir, path);
    const rel = relativeToProject(projectDir, fullPath);
    lines.push(`write ${path}`);
    overlay.set(rel, content);
    dirty.add(rel);
  }

  for (const dep of changes.dependencies) {
    assertSafeKey("dependency", dep.name);
    lines.push(`dependency ${dep.name}@${dep.version}${dep.dev ? " (dev)" : ""}${dep.app ? ` in ${dep.app}` : ""}`);
    await setPackageJsonEntry(
      projectDir,
      dep.app,
      dep.dev ? "devDependencies" : "dependencies",
      dep.name,
      dep.version,
      overlay,
      dirty,
    );
  }

  for (const scr of changes.scripts) {
    assertSafeKey("script", scr.name);
    lines.push(`script "${scr.name}": "${scr.command}"${scr.app ? ` in ${scr.app}` : ""}`);
    await setPackageJsonEntry(projectDir, scr.app, "scripts", scr.name, scr.command, overlay, dirty);
  }

  for (const env of changes.envs) {
    if (!env.name || /[\s=\r\n]/.test(env.name)) {
      throw new UsageError(`Invalid environment variable name "${env.name}".`);
    }
    if (/[\r\n]/.test(env.value)) {
      throw new UsageError(`Invalid environment variable "${env.name}": must not contain newlines.`);
    }
    const appDir = env.app ? assertSafePath(projectDir, env.app, true) : projectDir;
    const rel = relativeToProject(projectDir, join(appDir, ".env"));
    lines.push(`env ${env.name}=${env.value}${env.app ? ` in ${env.app}` : ""}`);
    const existing = (await readOverlayOrDisk(projectDir, rel, overlay)) ?? "";
    const keyPattern = new RegExp(`^\\s*(?:export\\s+)?${escapeRegex(env.name)}\\s*=`, "m");
    if (!keyPattern.test(existing)) {
      const line = `${env.name}=${env.value}\n`;
      overlay.set(rel, existing + (existing.endsWith("\n") || !existing ? "" : "\n") + line);
      dirty.add(rel);
    }
  }

  return lines;
}

async function flushDirtyFiles(projectDir: string, overlay: Map<string, string>, dirty: Set<string>): Promise<void> {
  for (const rel of dirty) {
    const fullPath = assertSafePath(projectDir, rel);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, overlay.get(rel)!);
  }
}

export async function applyPluginChanges(
  projectDir: string,
  changes: PluginChanges,
  dryRun = false,
): Promise<string[]> {
  const overlay = new Map<string, string>();
  const dirty = new Set<string>();
  const lines = await stagePluginChanges(projectDir, changes, overlay, dirty);
  if (!dryRun) await flushDirtyFiles(projectDir, overlay, dirty);
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

async function stageRecordedPlugins(
  directory: string,
  plugins: PluginRecord[],
  overlay: Map<string, string>,
  dirty: Set<string>,
): Promise<void> {
  const raw = await readOverlayOrDisk(directory, "package.json", overlay);
  if (raw === null) return;
  const manifest = parseJsonObject(raw, "package.json");
  if (!manifest.clubedge || typeof manifest.clubedge !== "object" || Array.isArray(manifest.clubedge)) {
    manifest.clubedge = {};
  }
  (manifest.clubedge as Record<string, unknown>).plugins = plugins;
  overlay.set("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  dirty.add("package.json");
}

export interface ApplyPluginsOptions {
  yes?: boolean;
  dryRun?: boolean;
  initialFiles?: Record<string, string>;
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
    initialFiles = {},
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
    const overlay = new Map<string, string>(Object.entries(initialFiles));
    const dirty = new Set<string>();

    for (const spec of plugins) {
      const at = spec.lastIndexOf("@");
      const name = spec.slice(0, at);
      const version = spec.slice(at + 1);
      const pkgDir = join(tempDir, "node_modules", ...name.split("/"));

      const { entryPath } = await loadPluginFromDirectory(pkgDir, spec, context);
      const integrity = await extractLockfileIntegrity(tempDir, name, version);
      records.push({ name, version, integrity });

      const changes = await runPluginSandbox(entryPath, pkgDir, projectDir, context, {
        installRoot: tempDir,
        overlay: Object.fromEntries(overlay),
      });
      const lines = await stagePluginChanges(projectDir, changes, overlay, dirty);
      if (lines.length > 0) {
        dryRunLines.push(`Plugin ${spec}:`);
        dryRunLines.push(...lines.map((l) => `  • ${l}`));
      }
    }

    if (!dryRun) {
      await stageRecordedPlugins(projectDir, records, overlay, dirty);
      await flushDirtyFiles(projectDir, overlay, dirty);
    }

    return { records, dryRunLines };
  } finally {
    await cleanup();
  }
}
