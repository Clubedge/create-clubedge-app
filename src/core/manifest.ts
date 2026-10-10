import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const MANIFEST_FILE = "clubedge.template.json";
export const SUPPORTED_SCHEMA_VERSION = 2;

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

/**
 * How a Starter describes itself to the CLI (clubedge.template.json). Top-level paths describe
 * the generated project; `frameworks` says where each framework's files live in the Starter.
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
    exclude: data.exclude ?? [],
  };
}

function parseFrameworks(data: Record<string, unknown>) {
  const { frameworks } = data;
  if (!isRecord(frameworks) || Object.keys(frameworks).length === 0) {
    throw new ManifestError(`${MANIFEST_FILE}: frameworks must describe at least one framework.`);
  }

  const parsed: Record<string, FrameworkTemplate> = {};
  for (const [id, entry] of Object.entries(frameworks)) {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
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
