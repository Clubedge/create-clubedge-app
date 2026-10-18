// Field readers shared by the manifest schemas. Each one names the file and the field in its
// error, so a Starter maintainer sees exactly what to fix.

export const MANIFEST_FILE = "clubedge.template.json";

export class ManifestError extends Error {
  override name = "ManifestError";
}

/** What an app is for: the whole app, a frontend that calls an API, or that API. */
export type StackRole = "fullstack" | "frontend" | "api";
export const stackRoles: readonly StackRole[] = ["fullstack", "frontend", "api"];

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
  files: string[];
  replace: Record<string, string>;
  requires: Record<string, string[]>;
  scripts: Record<string, string>;
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
      files: read.optionalStringArray(values, "files"),
      replace: read.optionalStringRecord(values, "replace"),
      requires: parseRequires(file, values.requires, optionPrefix),
      scripts: read.optionalStringRecord(values, "scripts"),
    };
  }

  const defaultOption = requireString(record, "default");
  if (!options[defaultOption]) fail(`${prefix}default "${defaultOption}" is not in its options.`);
  return { name: requireString(record, "name"), default: defaultOption, options };
}
