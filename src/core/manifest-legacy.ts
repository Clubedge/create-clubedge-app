// Schema 1 to 3: one clubedge.template.json with every framework and module file. These
// Starters predate slots and stack packs, so each framework becomes a full-stack stack in the
// "framework" slot, implementing every module option.
import { fields, FRAMEWORK_SLOT, ID, isRecord, isStringArray, MANIFEST_FILE, ManifestError, parseModule } from "./manifest-fields.js";
import type { TemplateManifest, TemplateModule, TemplateSlot, TemplateStack } from "./manifest.js";

const frameworkSlot = (
  path: string,
  appPackage: string | undefined,
  env: { example: string; target: string },
  defaultFramework: string,
): TemplateSlot => ({
  name: "Framework",
  question: "Which framework should the app use?",
  path,
  ...(appPackage ? { package: appPackage } : {}),
  env,
  dockerfile: "Dockerfile",
  roles: ["fullstack"],
  default: defaultFramework,
  packages: {},
});

const fullstack = (name: string, app: string, envExample: string, dockerfile: string): TemplateStack => ({
  name,
  role: "fullstack",
  slot: FRAMEWORK_SLOT,
  app,
  envExample,
  dockerfile,
  modules: {},
});

/** Starter releases before v0.3.0 have no manifest; this describes their layout. */
export const legacyManifest: TemplateManifest = {
  schemaVersion: 1,
  name: "clubedge-starter",
  packageManager: "pnpm",
  siteConfig: "apps/web/src/config/site.json",
  dockerImage: "clubedge-starter",
  slots: {
    [FRAMEWORK_SLOT]: frameworkSlot("apps/web", undefined, { example: ".env.example", target: "apps/web/.env.local" }, "next"),
  },
  stacks: { next: fullstack("Next.js", "apps/web", ".env.example", "Dockerfile") },
  modules: {},
  conditional: [],
  exclude: [],
};

export function parseLegacyManifest(data: Record<string, unknown>, schemaVersion: number): TemplateManifest {
  const { fail, requireString, optionalStringArray } = fields(MANIFEST_FILE);
  const env = data.env;
  if (data.packageManager !== "pnpm") fail(`packageManager must be "pnpm".`);
  if (!isRecord(env)) fail("env must be an object.");
  if (data.exclude !== undefined && !isStringArray(data.exclude)) fail("exclude must be an array of paths.");

  const app = requireString(data, "app");
  const envFiles = {
    example: fields(MANIFEST_FILE, "env.").requireString(env as Record<string, unknown>, "example"),
    target: fields(MANIFEST_FILE, "env.").requireString(env as Record<string, unknown>, "target"),
  };
  const appPackage = schemaVersion >= 2 ? requireString(data, "appPackage") : undefined;
  const { defaultFramework, stacks } =
    schemaVersion >= 2
      ? parseFrameworks(data)
      : { defaultFramework: "next", stacks: { next: fullstack("Next.js", app, envFiles.example, "Dockerfile") } };
  const modules = schemaVersion >= 3 ? parseModules(data.modules) : {};

  // Every framework of these Starters implements every option.
  for (const stack of Object.values(stacks)) {
    stack.modules = Object.fromEntries(Object.entries(modules).map(([id, module]) => [id, Object.keys(module.options)]));
  }
  return {
    schemaVersion,
    name: requireString(data, "name"),
    packageManager: "pnpm",
    siteConfig: requireString(data, "siteConfig"),
    dockerImage: requireString(data, "dockerImage"),
    slots: { [FRAMEWORK_SLOT]: frameworkSlot(app, appPackage, envFiles, defaultFramework) },
    stacks,
    modules,
    conditional: schemaVersion >= 3 ? optionalStringArray(data, "conditional") : [],
    exclude: (data.exclude as string[] | undefined) ?? [],
  };
}

function parseModules(value: unknown): Record<string, TemplateModule> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ManifestError(`${MANIFEST_FILE}: modules must be an object.`);
  const modules: Record<string, TemplateModule> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!ID.test(id) || id === FRAMEWORK_SLOT) {
      throw new ManifestError(`${MANIFEST_FILE}: "${id}" is not a valid module id.`);
    }
    modules[id] = { ...parseModule(MANIFEST_FILE, entry, `modules.${id}.`), scope: "app" };
  }
  return modules;
}

function parseFrameworks(data: Record<string, unknown>) {
  const { fail, requireString } = fields(MANIFEST_FILE);
  const { frameworks } = data;
  if (!isRecord(frameworks) || Object.keys(frameworks).length === 0) {
    fail("frameworks must describe at least one framework.");
  }

  const stacks: Record<string, TemplateStack> = {};
  for (const [id, entry] of Object.entries(frameworks as Record<string, unknown>)) {
    if (!ID.test(id)) fail(`"${id}" is not a valid framework id.`);
    if (!isRecord(entry)) fail(`frameworks.${id} must be an object.`);
    const read = fields(MANIFEST_FILE, `frameworks.${id}.`);
    const framework = entry as Record<string, unknown>;
    stacks[id] = fullstack(
      read.requireString(framework, "name"),
      read.requireString(framework, "app"),
      read.requireString(framework, "envExample"),
      read.requireString(framework, "dockerfile"),
    );
  }

  const defaultFramework = requireString(data, "defaultFramework");
  if (!stacks[defaultFramework]) fail(`defaultFramework "${defaultFramework}" is not in frameworks.`);
  return { defaultFramework, stacks };
}
