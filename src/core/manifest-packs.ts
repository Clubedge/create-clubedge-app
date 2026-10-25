// Schema 4 to 6: the Starter is assembled from packs, so each part is described in one place.
//
//   clubedge.template.json            the project: slots, module order, shared files
//   clubedge/modules/<id>.json        a module: its options, packages, scripts, shared files
//   apps/<name>/clubedge.stack.json   a stack: its role, and the files it has for each option
//
// A stack's paths are relative to its own folder, so a stack pack is self-contained: adding a
// stack, in any language, adds a folder and changes nothing shared. Its files for an option
// join that option's files, so the rest of the CLI sees one list per option, as before.
//
// Schema 5 only adds the shell role: an app that packages a frontend's build, such as a mobile
// app. Schema 6 only adds the mobile role: a mobile app with its own native screens that calls
// the API. Neither runs a server, so they have no Dockerfile or deployment, and their slots no
// Dockerfile.
import { posix } from "node:path";
import {
  fields,
  ID,
  isRecord,
  isStringArray,
  MANIFEST_FILE,
  ManifestError,
  parseModule,
  roleSchema,
  runsServer,
  stackRoles,
  type StackRole,
} from "./manifest-fields.js";
import type { StackDeployment, TemplateManifest, TemplateModule, TemplateSlot, TemplateStack, Toolchain } from "./manifest.js";

export const STACKS_DIRECTORY = "apps";
export const STACK_FILE = "clubedge.stack.json";
export const MODULES_DIRECTORY = "clubedge/modules";

/** The descriptors of a schema 4 Starter, read from its files. */
export interface Packs {
  /** Each stack's folder in the Starter and its parsed clubedge.stack.json. */
  stacks: Array<{ directory: string; data: unknown }>;
  /** Each module's parsed descriptor, by id. */
  modules: Record<string, unknown>;
}

export function parsePackManifest(data: Record<string, unknown>, packs: Packs): TemplateManifest {
  const { fail, requireString, optionalStringArray, requireRecord } = fields(MANIFEST_FILE);
  if (data.packageManager !== "pnpm") fail(`packageManager must be "pnpm".`);
  if (!isStringArray(data.modules)) fail("modules must list the module ids, in the order the CLI offers them.");
  // Each role came with a schema; a Starter on an older one is read as before, without the newer roles.
  const knownRoles = stackRoles.filter((role) => roleSchema[role] <= (data.schemaVersion as number));

  const slots: Record<string, TemplateSlot> = {};
  for (const [id, entry] of Object.entries(requireRecord(data, "slots"))) {
    slots[fields(MANIFEST_FILE).requireId(id, "slot")] = parseSlot(id, entry, knownRoles, data.schemaVersion as number);
  }
  if (Object.keys(slots).length === 0) fail("slots must describe at least one slot.");

  const modules: Record<string, TemplateModule> = {};
  for (const id of data.modules as string[]) {
    const file = `${MODULES_DIRECTORY}/${id}.json`;
    if (!ID.test(id)) fail(`"${id}" is not a valid module id.`);
    if (modules[id]) fail(`module "${id}" is listed twice.`);
    const descriptor = packs.modules[id];
    const scope = isRecord(descriptor) ? descriptor.scope ?? "app" : "app";
    if (scope !== "app" && scope !== "project") {
      throw new ManifestError(`${file}: scope must be "app" or "project".`);
    }
    modules[id] = { ...parseModule(file, descriptor, ""), scope };
  }

  const stacks: Record<string, TemplateStack> = {};
  const descriptorFiles: string[] = [];
  const conditional = optionalStringArray(data, "conditional");
  for (const { directory, data: descriptor } of packs.stacks) {
    const { id, stack, files } = parseStack(directory, descriptor, slots, modules, knownRoles);
    if (stacks[id]) throw new ManifestError(`${directory}/${STACK_FILE}: stack id "${id}" is already used.`);
    stacks[id] = stack;
    descriptorFiles.push(`${directory}/${STACK_FILE}`);
    conditional.push(...files.conditional);
    // A stack's files for an option join that option's, so planning sees one list per option.
    for (const { module, option, paths, replace } of files.options) {
      const target = modules[module]!.options[option]!;
      target.files.push(...paths.filter((path) => !target.files.includes(path)));
      Object.assign(target.replace, replace);
    }
  }

  return {
    schemaVersion: data.schemaVersion as number,
    name: requireString(data, "name"),
    packageManager: "pnpm",
    siteConfig: requireString(data, "siteConfig"),
    dockerImage: requireString(data, "dockerImage"),
    slots,
    stacks: orderStacks(stacks, slots),
    modules,
    conditional: [...new Set(conditional)],
    // The descriptors describe the Starter; generated projects never contain them.
    exclude: [...optionalStringArray(data, "exclude"), MODULES_DIRECTORY, ...descriptorFiles],
  };
}

function parseSlot(id: string, entry: unknown, knownRoles: readonly StackRole[], schemaVersion: number): TemplateSlot {
  const read = fields(MANIFEST_FILE, `slots.${id}.`);
  if (!isRecord(entry)) read.fail(`slots.${id} must be an object.`);
  const slot = entry as Record<string, unknown>;
  const env = read.requireRecord(slot, "env");
  const roles = slot.roles;
  if (!isStringArray(roles) || roles.length === 0 || !roles.every((role) => knownRoles.includes(role as StackRole))) {
    read.fail(`slots.${id}.roles must list one or more of: ${knownRoles.join(", ")}.`);
  }
  const packageName = read.optionalString(slot, "package");
  const defaultStack = read.optionalString(slot, "default");
  const siteConfig = read.optionalString(slot, "siteConfig");
  // Schema 6: a slot with a default may still be left empty, such as a project without a web app.
  if (slot.optional !== undefined && typeof slot.optional !== "boolean") read.fail(`slots.${id}.optional must be true or false.`);
  if (slot.optional === true && schemaVersion < 6) read.fail(`slots.${id}.optional needs template schema 6.`);
  const optional = slot.optional === true && defaultStack !== undefined;
  // A Dockerfile is for apps that run a server; a slot that only takes shells or mobile apps has none.
  const servers = (roles as StackRole[]).some(runsServer);
  return {
    name: read.requireString(slot, "name"),
    question: read.requireString(slot, "question"),
    path: read.requireString(slot, "path"),
    ...(packageName ? { package: packageName } : {}),
    env: {
      example: fields(MANIFEST_FILE, `slots.${id}.env.`).requireString(env, "example"),
      target: fields(MANIFEST_FILE, `slots.${id}.env.`).requireString(env, "target"),
    },
    ...(servers ? { dockerfile: read.requireString(slot, "dockerfile") } : {}),
    roles: roles as StackRole[],
    ...(defaultStack ? { default: defaultStack } : {}),
    ...(optional ? { optional: true as const } : {}),
    ...(siteConfig ? { siteConfig } : {}),
    packages: read.optionalStringRecord(slot, "packages"),
  };
}

interface StackFiles {
  conditional: string[];
  options: Array<{ module: string; option: string; paths: string[]; replace: Record<string, string> }>;
}

/** Reads one stack pack. Its paths are relative to its folder; they come back Starter-relative. */
function parseStack(
  directory: string,
  descriptor: unknown,
  slots: Record<string, TemplateSlot>,
  modules: Record<string, TemplateModule>,
  knownRoles: readonly StackRole[],
): { id: string; stack: TemplateStack; files: StackFiles } {
  const file = `${directory}/${STACK_FILE}`;
  const read = fields(file);
  if (!isRecord(descriptor)) read.fail("must contain an object.");
  const data = descriptor as Record<string, unknown>;
  const id = read.requireId(read.requireString(data, "id"), "stack");
  const role = read.requireString(data, "role") as StackRole;
  if (!knownRoles.includes(role)) read.fail(`role must be one of: ${knownRoles.join(", ")}.`);
  const slotIds = Object.keys(slots).filter((slotId) => slots[slotId]!.roles.includes(role));
  if (slotIds.length !== 1) {
    throw new ManifestError(`${MANIFEST_FILE}: exactly one slot must take ${role} stacks, such as ${id} (${file}).`);
  }
  // A shell or a mobile app is installed on devices and runs no server: it has no Dockerfile, and
  // nothing deploys it.
  const server = runsServer(role);
  if (!server && (data.dockerfile !== undefined || data.deployment !== undefined)) {
    read.fail(`${role === "shell" ? "a shell" : "a mobile app"} runs no server, so it has no dockerfile or deployment.`);
  }

  /** A path in the stack's folder as a Starter path; it may not leave the Starter. */
  const resolve = (path: string, where: string) => {
    const resolved = posix.normalize(posix.join(directory, path));
    if (resolved.startsWith("../") || resolved === ".." || posix.isAbsolute(path)) {
      read.fail(`${where} "${path}" is outside the Starter.`);
    }
    return resolved;
  };

  const files: StackFiles = {
    conditional: read.optionalStringArray(data, "conditional").map((path) => resolve(path, "conditional")),
    options: [],
  };
  const implemented: Record<string, string[]> = {};
  const moduleEntries = data.modules === undefined ? {} : read.requireRecord(data, "modules");
  for (const [moduleId, entry] of Object.entries(moduleEntries)) {
    const module = modules[moduleId] ?? read.fail(`modules.${moduleId} is not a module of this Starter.`);
    if (!isRecord(entry)) read.fail(`modules.${moduleId} must be an object.`);
    const options = new Set<string>();
    // Keys name one option or several ("supabase|better-auth") that share the same files.
    for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
      const where = `modules.${moduleId}.${key}`;
      const ids = key.split("|");
      const unknown = ids.find((option) => !module.options[option]);
      if (unknown !== undefined) read.fail(`${where} names unknown option "${unknown}".`);
      if (!isRecord(value)) read.fail(`${where} must be an object.`);
      const option = fields(file, `${where}.`);
      const paths = option.optionalStringArray(value as Record<string, unknown>, "files").map((path) => resolve(path, `${where}.files`));
      const replace = Object.fromEntries(
        Object.entries(option.optionalStringRecord(value as Record<string, unknown>, "replace")).map(([target, variant]) => [
          resolve(target, `${where}.replace`),
          resolve(variant, `${where}.replace`),
        ]),
      );
      for (const optionId of ids) {
        options.add(optionId);
        files.options.push({ module: moduleId, option: optionId, paths, replace });
      }
    }
    implemented[moduleId] = Object.keys(module.options).filter((option) => options.has(option));
  }

  const toolchain = data.toolchain === undefined ? undefined : parseToolchain(file, data.toolchain);
  const deployment = data.deployment === undefined ? undefined : parseDeployment(file, data.deployment);
  return {
    id,
    stack: {
      name: read.requireString(data, "name"),
      role,
      slot: slotIds[0]!,
      app: directory,
      envExample: resolve(read.requireString(data, "envExample"), "envExample"),
      ...(server ? { dockerfile: resolve(read.requireString(data, "dockerfile"), "dockerfile") } : {}),
      modules: implemented,
      ...(toolchain ? { toolchain } : {}),
      ...(deployment ? { deployment } : {}),
    },
    files,
  };
}

function parseDeployment(file: string, value: unknown): StackDeployment {
  const read = fields(file, "deployment.");
  if (!isRecord(value)) read.fail("deployment must be an object.");
  const deployment = value as Record<string, unknown>;
  const port = deployment.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    read.fail("deployment.port must be an integer from 1 to 65535.");
  }
  const platforms = read.optionalStringArray(deployment, "platforms");
  if (!platforms.length) read.fail("deployment.platforms must list at least one platform.");
  return {
    id: read.requireId(read.requireString(deployment, "id"), "deployment service"),
    port: port as number,
    healthPath: read.requireString(deployment, "healthPath"),
    platforms,
  };
}

function parseToolchain(file: string, value: unknown): Toolchain {
  const read = fields(file, "toolchain.");
  if (!isRecord(value)) read.fail("toolchain must be an object.");
  const toolchain = value as Record<string, unknown>;
  const command = (key: string) => {
    const parts = toolchain[key];
    if (!isStringArray(parts) || parts.length === 0) read.fail(`toolchain.${key} must be a command, as an array of words.`);
    return parts as string[];
  };
  return {
    name: read.requireString(toolchain, "name"),
    check: command("check"),
    install: command("install"),
    url: read.requireString(toolchain, "url"),
  };
}

/** Each slot's default stack first, then the others by name: the order the CLI offers them. */
function orderStacks(stacks: Record<string, TemplateStack>, slots: Record<string, TemplateSlot>) {
  const defaults = new Set(Object.values(slots).map((slot) => slot.default));
  const ids = Object.keys(stacks).sort((a, b) => {
    if (defaults.has(a) !== defaults.has(b)) return defaults.has(a) ? -1 : 1;
    return stacks[a]!.name.localeCompare(stacks[b]!.name);
  });
  return Object.fromEntries(ids.map((id) => [id, stacks[id]!]));
}
