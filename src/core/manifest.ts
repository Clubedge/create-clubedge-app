import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const MANIFEST_FILE = "clubedge.template.json";
export const SUPPORTED_SCHEMA_VERSION = 1;

/** How a Starter describes itself to the CLI (clubedge.template.json). */
export interface TemplateManifest {
  schemaVersion: number;
  name: string;
  packageManager: "pnpm";
  /** The application directory, relative to the template root. */
  app: string;
  /** JSON file holding the project name and description. */
  siteConfig: string;
  env: { example: string; target: string };
  /** Docker image name used by the root docker:* scripts. */
  dockerImage: string;
  /** Template files that should not be copied into generated projects. */
  exclude: string[];
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

  return {
    schemaVersion,
    name: requireString(data, "name"),
    packageManager: "pnpm",
    app: requireString(data, "app"),
    siteConfig: requireString(data, "siteConfig"),
    env: { example: requireString(env, "example", "env."), target: requireString(env, "target", "env.") },
    dockerImage: requireString(data, "dockerImage"),
    exclude: data.exclude ?? [],
  };
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
