import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const MANIFEST_FILE = "clubedge.template.json";
export const SUPPORTED_SCHEMA_VERSION = 3;

/** Where one framework's files live in the Starter repository. */
export interface FrameworkTemplate {
  /** Display name, such as "TanStack Start". */
  name: string;
  /** The framework's application directory in the Starter. Moved to `app` when selected. */
  app: string;
  /** The framework's environment example. Moved to `env.example` when selected. */
  envExample: string;
  /** The framework's Dockerfile. Moved to the project root when selected. */
  dockerfile: string;
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
}

/**
 * How a Starter describes itself to the CLI (clubedge.template.json). Top-level paths describe
 * the generated project; `frameworks` says where each framework's files live in the Starter,
 * and `modules` (schema 3) describes the optional parts.
 */
export interface TemplateManifest {
  schemaVersion: number;
  name: string;
  packageManager: "pnpm";
  /** The application directory in generated projects. */
  app: string;
  /** The application package name in generated projects, when the Starter defines one. */
  appPackage?: string;
  /** JSON file holding the project name and description. */
  siteConfig: string;
  env: { example: string; target: string };
  /** Docker image name used by the root docker:* scripts. */
  dockerImage: string;
  defaultFramework: string;
  frameworks: Record<string, FrameworkTemplate>;
  /** Optional parts of the app; empty before schema 3. */
  modules: Record<string, TemplateModule>;
  /** Text files with `clubedge:if` blocks, kept or dropped by the selected framework and modules. */
  conditional: string[];
  /** Template files that should not be copied into generated projects. */
  exclude: string[];
}

/** Schema 1 Starters ship a single Next.js app at the generated location. */
function singleNextFramework(app: string, envExample: string) {
  return {
    defaultFramework: "next",
    frameworks: { next: { name: "Next.js", app, envExample, dockerfile: "Dockerfile" } },
  };
}

/** Starter releases before v0.3.0 have no manifest; this describes their layout. */
export const legacyManifest: TemplateManifest = {
  schemaVersion: 1,
  name: "clubedge-starter",
  packageManager: "pnpm",
  app: "apps/web",
  siteConfig: "apps/web/src/config/site.json",
  env: { example: ".env.example", target: "apps/web/.env.local" },
  dockerImage: "clubedge-starter",
  ...singleNextFramework("apps/web", ".env.example"),
  modules: {},
  conditional: [],
  exclude: [],
};

export class ManifestError extends Error {
  override name = "ManifestError";
}

export function parseTemplateManifest(source: string): TemplateManifest {
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    throw new ManifestError(`${MANIFEST_FILE} is not valid JSON.`);
  }
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

  const env = data.env;
  if (data.packageManager !== "pnpm") {
    throw new ManifestError(`${MANIFEST_FILE}: packageManager must be "pnpm".`);
  }
  if (!isRecord(env)) throw new ManifestError(`${MANIFEST_FILE}: env must be an object.`);
  if (data.exclude !== undefined && !isStringArray(data.exclude)) {
    throw new ManifestError(`${MANIFEST_FILE}: exclude must be an array of paths.`);
  }

  const app = requireString(data, "app");
  const envExample = requireString(env, "example", "env.");
  return {
    schemaVersion,
    name: requireString(data, "name"),
    packageManager: "pnpm",
    app,
    ...(schemaVersion >= 2 ? { appPackage: requireString(data, "appPackage") } : {}),
    siteConfig: requireString(data, "siteConfig"),
    env: { example: envExample, target: requireString(env, "target", "env.") },
    dockerImage: requireString(data, "dockerImage"),
    ...(schemaVersion >= 2 ? parseFrameworks(data) : singleNextFramework(app, envExample)),
    modules: schemaVersion >= 3 ? parseModules(data.modules) : {},
    conditional: schemaVersion >= 3 ? optionalStringArray(data, "conditional") : [],
    exclude: data.exclude ?? [],
  };
}

const ID = /^[a-z][a-z0-9-]*$/;

function parseModules(value: unknown): Record<string, TemplateModule> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ManifestError(`${MANIFEST_FILE}: modules must be an object.`);

  const modules: Record<string, TemplateModule> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!ID.test(id) || id === "framework") {
      throw new ManifestError(`${MANIFEST_FILE}: "${id}" is not a valid module id.`);
    }
    if (!isRecord(entry)) throw new ManifestError(`${MANIFEST_FILE}: modules.${id} must be an object.`);
    const prefix = `modules.${id}.`;
    const optionsValue = entry.options;
    if (!isRecord(optionsValue) || Object.keys(optionsValue).length === 0) {
      throw new ManifestError(`${MANIFEST_FILE}: ${prefix}options must describe at least one option.`);
    }

    const options: Record<string, ModuleOption> = {};
    for (const [optionId, option] of Object.entries(optionsValue)) {
      const optionPrefix = `${prefix}options.${optionId}.`;
      if (!ID.test(optionId)) {
        throw new ManifestError(`${MANIFEST_FILE}: "${optionId}" is not a valid option id in ${prefix.slice(0, -1)}.`);
      }
      if (!isRecord(option)) throw new ManifestError(`${MANIFEST_FILE}: ${optionPrefix.slice(0, -1)} must be an object.`);
      options[optionId] = {
        name: requireString(option, "name", optionPrefix),
        packages: optionalStringRecord(option, "packages", optionPrefix),
        files: optionalStringArray(option, "files", optionPrefix),
        replace: optionalStringRecord(option, "replace", optionPrefix),
        requires: parseRequires(option.requires, optionPrefix),
        scripts: optionalStringRecord(option, "scripts", optionPrefix),
      };
    }

    const defaultOption = requireString(entry, "default", prefix);
    if (!options[defaultOption]) {
      throw new ManifestError(`${MANIFEST_FILE}: ${prefix}default "${defaultOption}" is not in its options.`);
    }
    modules[id] = { name: requireString(entry, "name", prefix), default: defaultOption, options };
  }

  // Requirements must name real modules and options, or a selection could never be valid.
  for (const [id, module] of Object.entries(modules)) {
    for (const [optionId, option] of Object.entries(module.options)) {
      for (const [requiredModule, allowed] of Object.entries(option.requires)) {
        const unknown = allowed.find((value) => !modules[requiredModule]?.options[value]);
        if (unknown !== undefined) {
          throw new ManifestError(
            `${MANIFEST_FILE}: modules.${id}.options.${optionId}.requires names unknown option ${requiredModule}=${unknown}.`,
          );
        }
      }
    }
  }
  return modules;
}

function parseRequires(value: unknown, prefix: string): Record<string, string[]> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ManifestError(`${MANIFEST_FILE}: ${prefix}requires must be an object.`);
  const requires: Record<string, string[]> = {};
  for (const [module, allowed] of Object.entries(value)) {
    const list = typeof allowed === "string" ? [allowed] : allowed;
    if (!isStringArray(list) || list.length === 0) {
      throw new ManifestError(`${MANIFEST_FILE}: ${prefix}requires.${module} must name one or more options.`);
    }
    requires[module] = list;
  }
  return requires;
}

function optionalStringArray(record: Record<string, unknown>, key: string, prefix = ""): string[] {
  const value = record[key];
  if (value === undefined) return [];
  if (!isStringArray(value)) throw new ManifestError(`${MANIFEST_FILE}: ${prefix}${key} must be an array of paths.`);
  return value;
}

function optionalStringRecord(record: Record<string, unknown>, key: string, prefix = ""): Record<string, string> {
  const value = record[key];
  if (value === undefined) return {};
  if (!isRecord(value) || !Object.values(value).every((item) => typeof item === "string" && item)) {
    throw new ManifestError(`${MANIFEST_FILE}: ${prefix}${key} must map names to paths.`);
  }
  return value as Record<string, string>;
}

function parseFrameworks(data: Record<string, unknown>) {
  const { frameworks } = data;
  if (!isRecord(frameworks) || Object.keys(frameworks).length === 0) {
    throw new ManifestError(`${MANIFEST_FILE}: frameworks must describe at least one framework.`);
  }

  const parsed: Record<string, FrameworkTemplate> = {};
  for (const [id, entry] of Object.entries(frameworks)) {
    if (!ID.test(id)) {
      throw new ManifestError(`${MANIFEST_FILE}: "${id}" is not a valid framework id.`);
    }
    if (!isRecord(entry)) throw new ManifestError(`${MANIFEST_FILE}: frameworks.${id} must be an object.`);
    const prefix = `frameworks.${id}.`;
    parsed[id] = {
      name: requireString(entry, "name", prefix),
      app: requireString(entry, "app", prefix),
      envExample: requireString(entry, "envExample", prefix),
      dockerfile: requireString(entry, "dockerfile", prefix),
    };
  }

  const defaultFramework = requireString(data, "defaultFramework");
  if (!parsed[defaultFramework]) {
    throw new ManifestError(`${MANIFEST_FILE}: defaultFramework "${defaultFramework}" is not in frameworks.`);
  }
  return { defaultFramework, frameworks: parsed };
}

export async function readTemplateManifest(templateRoot: string): Promise<TemplateManifest> {
  let source: string;
  try {
    source = await readFile(join(templateRoot, MANIFEST_FILE), "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return legacyManifest;
    throw error;
  }
  return parseTemplateManifest(source);
}

function requireString(record: Record<string, unknown>, key: string, prefix = ""): string {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new ManifestError(`${MANIFEST_FILE}: ${prefix}${key} must be a non-empty string.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
