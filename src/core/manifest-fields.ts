import type { RemovedOption, Support, SupportLevel } from "./manifest.js";

// Field readers shared by the manifest schemas. Each one names the file and the field in its
// error, so a Starter maintainer sees exactly what to fix.

export const MANIFEST_FILE = "clubedge.template.json";

export class ManifestError extends Error {
  override name = "ManifestError";
}

/**
 * What an app is for: the whole app, a frontend that calls an API, that API, a shell that
 * packages a frontend's static build, such as a mobile app, or a mobile app with its own native
 * screens that calls the API.
 */
export type StackRole = "fullstack" | "frontend" | "api" | "shell" | "mobile";
export const stackRoles: readonly StackRole[] = ["fullstack", "frontend", "api", "shell", "mobile"];

/** The template schema each role came with: a Starter on an older schema is read without it. */
export const roleSchema: Record<StackRole, number> = { fullstack: 4, frontend: 4, api: 4, shell: 5, mobile: 6 };

/** Whether a role's apps run a server: a shell and a mobile app are installed on devices instead. */
export const runsServer = (role: StackRole) => role !== "shell" && role !== "mobile";

/**
 * The slot for the app itself. Starters before schema 4 call it the framework, and projects
 * record their choice for it as `framework`.
 */
export const FRAMEWORK_SLOT = "framework";

/** Ids of slots, stacks, modules, and options: lowercase words joined by dashes. */
export const ID = /^[a-z][a-z0-9-]*$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Reads the fields of one JSON object, reporting errors against `file` and `prefix`. */
export function fields(file: string, prefix = "") {
  const fail = (message: string): never => {
    throw new ManifestError(`${file}: ${message}`);
  };
  return {
    fail,
    requireString(record: Record<string, unknown>, key: string): string {
      const value = record[key];
      if (typeof value !== "string" || !value) fail(`${prefix}${key} must be a non-empty string.`);
      return value as string;
    },
    optionalString(record: Record<string, unknown>, key: string): string | undefined {
      const value = record[key];
      if (value === undefined) return undefined;
      if (typeof value !== "string" || !value) fail(`${prefix}${key} must be a non-empty string.`);
      return value as string;
    },
    optionalStringArray(record: Record<string, unknown>, key: string): string[] {
      const value = record[key];
      if (value === undefined) return [];
      if (!isStringArray(value)) fail(`${prefix}${key} must be an array of paths.`);
      return value as string[];
    },
    optionalStringRecord(record: Record<string, unknown>, key: string): Record<string, string> {
      const value = record[key];
      if (value === undefined) return {};
      if (!isRecord(value) || !Object.values(value).every((item) => typeof item === "string" && item)) {
        fail(`${prefix}${key} must map names to paths.`);
      }
      return value as Record<string, string>;
    },
    requireRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
      const value = record[key];
      if (!isRecord(value)) fail(`${prefix}${key} must be an object.`);
      return value as Record<string, unknown>;
    },
    requireId(id: string, kind: string): string {
      if (!ID.test(id)) fail(`"${id}" is not a valid ${kind} id.`);
      return id;
    },
  };
}

/** `requires`: module id to the options allowed, as one option or several. */
export function parseRequires(file: string, value: unknown, prefix: string): Record<string, string[]> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ManifestError(`${file}: ${prefix}requires must be an object.`);
  const requires: Record<string, string[]> = {};
  for (const [module, allowed] of Object.entries(value)) {
    const list = typeof allowed === "string" ? [allowed] : allowed;
    if (!isStringArray(list) || list.length === 0) {
      throw new ManifestError(`${file}: ${prefix}requires.${module} must name one or more options.`);
    }
    requires[module] = list;
  }
  return requires;
}

/** One module option, the same in a schema 3 manifest and a schema 4 module descriptor. */
export interface ParsedOption {
  name: string;
  packages: Record<string, string>;
  dependencies: string[];
  files: string[];
  replace: Record<string, string>;
  requires: Record<string, string[]>;
  scripts: Record<string, string>;
  support?: Support;
}

/** An npm package name, scoped or not, such as expo-notifications or @capacitor/push-notifications. */
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/** `dependencies`: packages from the registry, by name. */
function parseDependencies(file: string, value: unknown, prefix: string): string[] {
  if (value === undefined) return [];
  if (!isStringArray(value) || !value.every((name) => PACKAGE_NAME.test(name))) {
    throw new ManifestError(`${file}: ${prefix}dependencies must be an array of package names.`);
  }
  return value;
}

export const supportLevels: readonly SupportLevel[] = ["stable", "beta", "experimental", "deprecated"];

/**
 * An option's or a stack's support level, from its `status`, with the `note`, and for a
 * deprecated one its `since`, `replacement`, and `offered`. Undefined when the Starter grades
 * nothing. A level this CLI does not know, from a newer Starter, reads as experimental.
 */
export function parseSupport(file: string, record: Record<string, unknown>, prefix: string): Support | undefined {
  if (record.status === undefined) return undefined;
  const read = fields(file, prefix);
  const status = read.requireString(record, "status");
  const level = (supportLevels as readonly string[]).includes(status) ? (status as SupportLevel) : "experimental";
  if (record.offered !== undefined && typeof record.offered !== "boolean") read.fail(`${prefix}offered must be true or false.`);
  const note = read.optionalString(record, "note");
  const since = read.optionalString(record, "since");
  const replacement = read.optionalString(record, "replacement");
  return {
    level,
    ...(note ? { note } : {}),
    ...(since ? { since } : {}),
    ...(replacement ? { replacement } : {}),
    offered: record.offered !== false,
  };
}

/** `removed`: options a Starter release took out, by id, with what replaces them. */
function parseRemoved(file: string, value: unknown, prefix: string): Record<string, RemovedOption> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new ManifestError(`${file}: ${prefix}removed must be an object.`);
  const removed: Record<string, RemovedOption> = {};
  for (const [optionId, entry] of Object.entries(value)) {
    if (!isRecord(entry)) throw new ManifestError(`${file}: ${prefix}removed.${optionId} must be an object.`);
    const read = fields(file, `${prefix}removed.${optionId}.`);
    const since = read.optionalString(entry, "since");
    const replacement = read.optionalString(entry, "replacement");
    const note = read.optionalString(entry, "note");
    removed[optionId] = { ...(since ? { since } : {}), ...(replacement ? { replacement } : {}), ...(note ? { note } : {}) };
  }
  return removed;
}

/** A module's name, default, and options; `prefix` locates it in its file. */
export function parseModule(file: string, entry: unknown, prefix: string) {
  const { fail, requireString } = fields(file, prefix);
  if (!isRecord(entry)) fail(`${prefix.slice(0, -1) || "the module"} must be an object.`);
  const record = entry as Record<string, unknown>;
  const optionsValue = record.options;
  if (!isRecord(optionsValue) || Object.keys(optionsValue).length === 0) {
    fail(`${prefix}options must describe at least one option.`);
  }

  const options: Record<string, ParsedOption> = {};
  for (const [optionId, option] of Object.entries(optionsValue as Record<string, unknown>)) {
    const optionPrefix = `${prefix}options.${optionId}.`;
    if (!ID.test(optionId)) fail(`"${optionId}" is not a valid option id in ${prefix ? prefix.slice(0, -1) : "options"}.`);
    if (!isRecord(option)) fail(`${optionPrefix.slice(0, -1)} must be an object.`);
    const read = fields(file, optionPrefix);
    const values = option as Record<string, unknown>;
    options[optionId] = {
      name: read.requireString(values, "name"),
      packages: read.optionalStringRecord(values, "packages"),
      dependencies: parseDependencies(file, values.dependencies, optionPrefix),
      files: read.optionalStringArray(values, "files"),
      replace: read.optionalStringRecord(values, "replace"),
      requires: parseRequires(file, values.requires, optionPrefix),
      scripts: read.optionalStringRecord(values, "scripts"),
    };
    const support = parseSupport(file, values, optionPrefix);
    if (support) options[optionId]!.support = support;
  }

  const defaultOption = requireString(record, "default");
  if (!options[defaultOption]) fail(`${prefix}default "${defaultOption}" is not in its options.`);
  const removed = parseRemoved(file, record.removed, prefix);
  return { name: requireString(record, "name"), default: defaultOption, options, ...(removed ? { removed } : {}) };
}
