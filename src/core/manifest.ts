// How a Starter describes itself to the CLI. Every schema the CLI has shipped is read into one
// model, so the rest of the CLI never branches on schema versions:
//
// - Schema 1 to 3 (manifest-legacy.ts): one clubedge.template.json listing every framework and
//   every module file. Projects created from those Starters still add, remove, and upgrade.
// - Schema 4 (manifest-packs.ts): clubedge.template.json names the slots and modules, and each
//   app describes itself in its own clubedge.stack.json, a stack pack. Adding a stack adds a
//   folder; nothing shared changes.
// - Schema 5 (manifest-packs.ts too): schema 4 plus the shell role, an app that packages a
//   frontend and runs no server. Older CLIs refuse it, asking for an update.
// - Schema 6 (manifest-packs.ts too): schema 5 plus the mobile role, a mobile app with its own
//   native screens that calls the API and runs no server. Older CLIs refuse it too.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { FRAMEWORK_SLOT, ID, isRecord, MANIFEST_FILE, ManifestError, stackRoles, type StackRole } from "./manifest-fields.js";
import { legacyManifest, parseLegacyManifest } from "./manifest-legacy.js";
import { MODULES_DIRECTORY, parsePackManifest, STACK_FILE, STACKS_DIRECTORY, type Packs } from "./manifest-packs.js";

export { FRAMEWORK_SLOT, legacyManifest, MANIFEST_FILE, ManifestError };
export const SUPPORTED_SCHEMA_VERSION = 6;

export { stackRoles, type StackRole };

/**
 * A place for one app in generated projects, such as the web app in apps/web. The selected
 * stack's app, environment example, and Dockerfile move here. Slots without a default are
 * optional: "none" leaves them out.
 */
export interface TemplateSlot {
  /** Display name, such as "Framework"; the README and errors use it. */
  name: string;
  /** The prompt that offers its stacks. */
  question: string;
  /** The app's directory in generated projects. */
  path: string;
  /** The app's package name in generated projects, when the Starter defines one. */
  package?: string;
  env: { example: string; target: string };
  /** Where the app's Dockerfile goes in generated projects; absent when it only takes shells, which run no server. */
  dockerfile?: string;
  /** The roles of the stacks it takes. */
  roles: StackRole[];
  /** The stack used when none is requested; absent for optional slots. */
  default?: string;
  /**
   * The app's own site config in generated projects, named like the project, for slots other
   * than the framework slot (which uses the manifest's siteConfig).
   */
  siteConfig?: string;
  /** Workspace packages (name to directory) only this slot's apps use; left out when it is empty. */
  packages: Record<string, string>;
}

/**
 * The tools a stack needs beyond the workspace's pnpm install, such as uv for a Python API.
 * Data, not code: a stack in a new language brings its toolchain with it.
 */
export interface Toolchain {
  /** Display name, such as "uv". */
  name: string;
  /** A command that succeeds when the tool is installed, such as ["uv", "--version"]. */
  check: string[];
  /** Installs the app's dependencies, run in the app's directory after pnpm install. */
  install: string[];
  /** Where to get the tool, shown when it is missing. */
  url: string;
}

/** Runtime facts for one generated service, declared by its stack rather than the CLI. */
export interface StackDeployment {
  id: string;
  port: number;
  healthPath: string;
  platforms: string[];
}

export interface ProjectService extends StackDeployment {
  role: StackRole;
  app: string;
  dockerfile: string;
}

/** One app implementation in the Starter (a stack pack), such as Next.js in apps/web. */
export interface TemplateStack {
  /** Display name, such as "TanStack Start". */
  name: string;
  role: StackRole;
  /** The slot it fills, from its role. */
  slot: string;
  /** Its directory in the Starter. Moved to the slot's path when selected. */
  app: string;
  /** Its environment example in the Starter. Moved to the slot's env.example when selected. */
  envExample: string;
  /** Its Dockerfile in the Starter, moved to the slot's dockerfile when selected; a shell has none. */
  dockerfile?: string;
  /** The module options it implements, by module. Modules it does not list do not involve it. */
  modules: Record<string, string[]>;
  toolchain?: Toolchain;
  deployment?: StackDeployment;
  /**
   * Advisories `pnpm audit` skips for this stack's dependencies, which the Starter's package.json
   * lists under `pnpm.auditConfig.ignoreGhsas`. Projects without the stack stop skipping them.
   */
  auditIgnores?: string[];
}

/** One choice within a module, such as `storage: s3`. Paths use the Starter's layout. */
export interface ModuleOption {
  name: string;
  /** Workspace packages (name to directory) this option uses. Unused ones are left out. */
  packages: Record<string, string>;
  /** Paths owned by this option. A path is kept only when a selected option owns it. */
  files: string[];
  /** Default files replaced by variants when this option is selected: target to variant. */
  replace: Record<string, string>;
  /** Options that must be selected alongside this one, by module. */
  requires: Record<string, string[]>;
  /** Root package.json scripts this option sets; left-out options' scripts are removed. */
  scripts: Record<string, string>;
}

/** A replaceable part of the app, such as authentication or storage. */
export interface TemplateModule {
  name: string;
  default: string;
  options: Record<string, ModuleOption>;
  /**
   * "app": apps implement it, so a selected stack must implement the chosen option.
   * "project": it is about the project as a whole (local infrastructure, deployment).
   */
  scope: "app" | "project";
}

export interface TemplateManifest {
  schemaVersion: number;
  name: string;
  /** The workspace's package manager; every app has a package.json, whatever its language. */
  packageManager: "pnpm";
  /** JSON file in generated projects holding the project name and description. */
  siteConfig: string;
  /** Docker image name used by the root docker:* scripts. */
  dockerImage: string;
  slots: Record<string, TemplateSlot>;
  stacks: Record<string, TemplateStack>;
  /** Optional parts of the app; empty before schema 3. */
  modules: Record<string, TemplateModule>;
  /** Text files with `clubedge:if` blocks, kept or dropped by the selected stacks and modules. */
  conditional: string[];
  /** Template files that should not be copied into generated projects. */
  exclude: string[];
}

/** The schema version of a manifest file, checked against what this CLI reads. */
function readSchemaVersion(data: unknown): number {
  if (!isRecord(data)) throw new ManifestError(`${MANIFEST_FILE} must contain an object.`);
  const { schemaVersion } = data;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    throw new ManifestError(`${MANIFEST_FILE} is missing a numeric schemaVersion.`);
  }
  if (schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    throw new ManifestError(
      `This Starter uses template schema ${schemaVersion}, but this CLI supports up to ${SUPPORTED_SCHEMA_VERSION}. ` +
        "Run the latest CLI: pnpm dlx @clubedge/create-clubedge-app@latest",
    );
  }
  return schemaVersion;
}

function parseJson(source: string, file: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    throw new ManifestError(`${file} is not valid JSON.`);
  }
}

/**
 * Reads a manifest from its text. Schema 4 and later manifests also need their packs, the stack
 * and module descriptors, which readTemplateManifest collects from the Starter.
 */
export function parseTemplateManifest(source: string, packs?: Packs): TemplateManifest {
  const data = parseJson(source, MANIFEST_FILE);
  const schemaVersion = readSchemaVersion(data);
  const manifest =
    schemaVersion >= 4
      ? parsePackManifest(data as Record<string, unknown>, packs ?? { stacks: [], modules: {} })
      : parseLegacyManifest(data as Record<string, unknown>, schemaVersion);
  return validateManifest(manifest);
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    throw error;
  }
}

/** The stack and module descriptors of a Starter assembled from packs (schema 4 and later). */
async function readPacks(templateRoot: string, data: Record<string, unknown>): Promise<Packs> {
  const stacks: Packs["stacks"] = [];
  let entries: string[] = [];
  try {
    entries = (await readdir(join(templateRoot, STACKS_DIRECTORY), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (!(isRecord(error) && error.code === "ENOENT")) throw error;
  }
  for (const name of entries) {
    const directory = `${STACKS_DIRECTORY}/${name}`;
    const source = await readOptional(join(templateRoot, directory, STACK_FILE));
    if (source !== null) stacks.push({ directory, data: parseJson(source, `${directory}/${STACK_FILE}`) });
  }

  const modules: Packs["modules"] = {};
  const ids = Array.isArray(data.modules) ? data.modules.filter((id) => typeof id === "string") : [];
  for (const id of ids) {
    // Checked before reading, so a module id never reaches outside clubedge/modules.
    if (!ID.test(id)) throw new ManifestError(`${MANIFEST_FILE}: "${id}" is not a valid module id.`);
    const file = `${MODULES_DIRECTORY}/${id}.json`;
    const source = await readOptional(join(templateRoot, file));
    if (source === null) throw new ManifestError(`${MANIFEST_FILE}: module "${id}" has no ${file}.`);
    modules[id] = parseJson(source, file);
  }
  return { stacks, modules };
}

export async function readTemplateManifest(templateRoot: string): Promise<TemplateManifest> {
  const source = await readOptional(join(templateRoot, MANIFEST_FILE));
  if (source === null) return legacyManifest;
  const data = parseJson(source, MANIFEST_FILE);
  if (readSchemaVersion(data) < 4) return parseTemplateManifest(source);
  return parseTemplateManifest(source, await readPacks(templateRoot, data as Record<string, unknown>));
}

/**
 * Checks what no single file can: slots, stacks, and modules refer to each other correctly, so
 * every selection the CLI offers can be generated.
 */
function validateManifest(manifest: TemplateManifest): TemplateManifest {
  const fail = (message: string): never => {
    throw new ManifestError(`${MANIFEST_FILE}: ${message}`);
  };
  const { slots, stacks, modules } = manifest;

  for (const id of Object.keys(slots)) {
    if (modules[id]) fail(`"${id}" names both a slot and a module.`);
  }
  for (const [id, stack] of Object.entries(stacks)) {
    if (!slots[stack.slot]) fail(`stack "${id}" has no slot for the ${stack.role} role.`);
    for (const [moduleId, options] of Object.entries(stack.modules)) {
      const module = modules[moduleId] ?? fail(`stack "${id}" implements unknown module "${moduleId}".`);
      const unknown = options.find((option) => !module.options[option]);
      if (unknown !== undefined) fail(`stack "${id}" implements unknown option ${moduleId}=${unknown}.`);
    }
  }
  for (const [id, slot] of Object.entries(slots)) {
    if (slot.default !== undefined && stacks[slot.default]?.slot !== id) {
      fail(`slot "${id}" defaults to "${slot.default}", which is not one of its stacks.`);
    }
  }

  for (const [id, module] of Object.entries(modules)) {
    for (const [optionId, option] of Object.entries(module.options)) {
      // Requirements must name real modules and options, or a selection could never be valid.
      for (const [requiredModule, allowed] of Object.entries(option.requires)) {
        const unknown = allowed.find((value) => !modules[requiredModule]?.options[value]);
        if (unknown !== undefined) {
          fail(`modules.${id}.options.${optionId}.requires names unknown option ${requiredModule}=${unknown}.`);
        }
      }
      // An option no stack implements could never be selected: usually a missing stack entry.
      if (
        module.scope === "app" &&
        Object.keys(stacks).length > 0 &&
        !Object.values(stacks).some((stack) => stack.modules[id]?.includes(optionId))
      ) {
        fail(`no stack implements ${id}=${optionId}.`);
      }
    }
  }
  return manifest;
}
