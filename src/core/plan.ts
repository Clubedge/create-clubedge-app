import {
  applyConditionals,
  customizeAppManifest,
  customizeLegacySource,
  customizeLockfile,
  customizeReadme,
  customizeRootManifest,
  customizeSiteConfig,
  legacyBrandedFiles,
  removePackageDependencies,
  type LockfileChanges,
  type ProjectIdentity,
  type Provenance,
  type ScriptChanges,
  type Selection,
} from "./customize.js";
import { runsServer } from "./manifest-fields.js";
import { FRAMEWORK_SLOT, isOptionalSlot, type StackRole, type TemplateManifest, type TemplateSlot, type TemplateStack, type Toolchain } from "./manifest.js";
import type { TemplateSource } from "./source.js";

export interface FileEdit {
  path: string;
  description: string;
  apply(source: string): string;
}

/** A selected stack, in the slot it fills. */
export interface SelectedApp {
  slot: string;
  slotName: string;
  id: string;
  name: string;
}

/** Everything the CLI will do, decided before anything is written. */
export interface ScaffoldPlan {
  targetDirectory: string;
  identity: ProjectIdentity;
  provenance: Provenance;
  /** The selected stack in each filled slot, in slot order. */
  apps: SelectedApp[];
  /** The selected option per module, with display names. Empty before schema 3. */
  modules: Array<{ id: string; name: string; option: string; optionName: string }>;
  files: Array<{ from: string; to: string }>;
  edits: FileEdit[];
  /** Environment examples copied to each app's local env file, when the template has them. */
  envFiles: Array<{ from: string; to: string }>;
  /**
   * The local env file with the database URLs: the API's when the project has one, since the API
   * owns the database, else the app's. Null when the template has no env files.
   */
  databaseEnvFile: string | null;
  /** Apps whose own tools install their dependencies after pnpm install, such as uv. */
  toolchains: Array<{ directory: string; app: string; toolchain: Toolchain }>;
  git: boolean;
  install: boolean;
}

export interface PlanInput {
  targetDirectory: string;
  identity: ProjectIdentity;
  source: Pick<TemplateSource, "files" | "repository" | "ref" | "commit">;
  manifest: TemplateManifest;
  /** The stack per slot, such as `{ framework: "next" }`; unlisted slots use their defaults. */
  stacks?: Record<string, string>;
  /** Requested module options by module id; unlisted modules use their defaults. */
  modules?: Record<string, string>;
  cliVersion: string;
  git: boolean;
  install: boolean;
}

export class StackError extends Error {
  override name = "StackError";
}

export class ModuleError extends Error {
  override name = "ModuleError";
}

const LOCKFILE = "pnpm-lock.yaml";

/** Leaves an optional slot empty, such as `--api none`. */
export const NO_STACK = "none";

const isWithin = (path: string, directory: string) =>
  path === directory || path.startsWith(`${directory.replace(/\/$/, "")}/`);

function isExcluded(path: string, exclude: string[]): boolean {
  return exclude.some((entry) => isWithin(path, entry));
}

/**
 * Splits selection flags into stacks by slot and module options: --framework fills the
 * framework slot, a flag named after another slot (--api, --shell) fills it, and the rest are
 * modules.
 */
export function splitSelection(manifest: TemplateManifest, framework: string | undefined, flags: Record<string, string>) {
  const stacks: Record<string, string> = {};
  const modules: Record<string, string> = {};
  for (const [name, value] of Object.entries(flags)) {
    if (manifest.slots[name] && name !== FRAMEWORK_SLOT) stacks[name] = value;
    else modules[name] = value;
  }
  if (framework !== undefined) stacks[FRAMEWORK_SLOT] = framework;
  return { stacks, modules };
}

/** The stacks a slot offers, in the order the CLI shows them. */
export function stacksIn(manifest: TemplateManifest, slotId: string): string[] {
  return Object.keys(manifest.stacks).filter((id) => manifest.stacks[id]!.slot === slotId);
}

/** Slots are filled with flags named after them: --framework, --api, --shell, --mobile. */
const slotFlag = (slotId: string) => `--${slotId}`;

/**
 * Resolves one stack per slot from the request and the defaults, with a helpful error for
 * unknown ids, then checks the roles fit together: a frontend needs an API, a full-stack app
 * already has its own server, a shell needs a frontend to package, and a mobile app needs an API.
 */
export function selectStacks(manifest: TemplateManifest, requested: Record<string, string> = {}): Selection {
  const unknownSlot = Object.keys(requested).find((id) => !manifest.slots[id]);
  if (unknownSlot !== undefined) {
    throw new StackError(`This Starter has no ${unknownSlot} choice; remove ${slotFlag(unknownSlot)}.`);
  }

  const selection: Selection = {};
  for (const [slotId, slot] of Object.entries(manifest.slots)) {
    const optional = isOptionalSlot(slot);
    const id = requested[slotId] ?? slot.default ?? NO_STACK;
    if (!(optional && id === NO_STACK) && manifest.stacks[id]?.slot !== slotId) {
      const choices = [...stacksIn(manifest, slotId), ...(optional ? [NO_STACK] : [])].join(", ");
      throw new StackError(`Unknown ${slot.name.toLowerCase()} "${id}". This Starter offers: ${choices}.`);
    }
    selection[slotId] = id;
  }

  const conflict = roleConflict(manifest, selection);
  if (conflict) throw new StackError(conflict);
  return selection;
}

/**
 * Why the chosen stacks cannot work together, or null when they can: a frontend calls an API, a
 * full-stack app has its own server, a shell packages a frontend's static build, which a
 * full-stack app does not have, and a mobile app calls an API, which a full-stack app does not
 * have apart from its pages. Slots not chosen yet (`pending`) may still bring the API a frontend
 * or a mobile app needs, or the frontend a shell packages.
 */
function roleConflict(manifest: TemplateManifest, chosen: Selection, pending: string[] = []): string | null {
  const stacks = Object.values(chosen).flatMap((id) => manifest.stacks[id] ?? []);
  const withRole = (role: StackRole) => stacks.find((stack) => stack.role === role);
  const slotFor = (role: StackRole) => Object.keys(manifest.slots).find((id) => manifest.slots[id]!.roles.includes(role));
  const apiSlot = slotFor("api");
  const frontendSlot = slotFor("frontend");
  const frontend = withRole("frontend");
  const fullstack = withRole("fullstack");
  const api = withRole("api");
  const shell = withRole("shell");
  const mobile = withRole("mobile");
  const apiPending = Boolean(apiSlot && pending.includes(apiSlot));
  const apis = apiSlot ? ` (${stacksIn(manifest, apiSlot).join(", ")})` : "";
  if (frontend && !api && !apiPending) {
    return `${frontend.name} is a frontend and calls an API: choose one with ${slotFlag(apiSlot ?? "api")}${apis}.`;
  }
  if (fullstack && api) {
    return `${fullstack.name} has its own server, so it does not call ${api.name}: choose a frontend, or ${slotFlag(apiSlot!)} ${NO_STACK}.`;
  }
  if (shell && fullstack) {
    return `${fullstack.name} renders pages on its server, so ${shell.name} cannot package it: choose a frontend, or ${slotFlag(shell.slot)} ${NO_STACK}.`;
  }
  if (shell && !frontend && !(frontendSlot && pending.includes(frontendSlot))) {
    const frontends = Object.keys(manifest.stacks).filter((id) => manifest.stacks[id]!.role === "frontend");
    const choices = frontends.length ? ` (${frontends.join(", ")})` : "";
    return `${shell.name} packages a frontend's static files: choose one with ${slotFlag(frontendSlot ?? FRAMEWORK_SLOT)}${choices}.`;
  }
  if (mobile && fullstack) {
    return `${fullstack.name} has no separate API for ${mobile.name} to call: choose a frontend with an API, or ${slotFlag(mobile.slot)} ${NO_STACK}.`;
  }
  if (mobile && !api && !apiPending) {
    return `${mobile.name} is a mobile app and calls an API: choose one with ${slotFlag(apiSlot ?? "api")}${apis}.`;
  }
  // Something has to run: a web app, or an API.
  const serverPending = pending.some((id) => manifest.slots[id]!.roles.some(runsServer));
  if (!stacks.some((stack) => runsServer(stack.role)) && !serverPending) {
    return `A project needs a web app or an API: choose one with ${slotFlag(FRAMEWORK_SLOT)}${apiSlot ? ` or ${slotFlag(apiSlot)}` : ""}.`;
  }
  return null;
}

/**
 * The stacks a slot can take next to the ones already chosen, for prompts: its stacks, and
 * "none" for an optional slot, that fit the chosen stacks' roles. Slots after it are pending.
 */
export function slotChoices(manifest: TemplateManifest, slotId: string, chosen: Selection = {}): string[] {
  const slot = manifest.slots[slotId]!;
  const slotIds = Object.keys(manifest.slots);
  const pending = slotIds.slice(slotIds.indexOf(slotId) + 1).filter((id) => chosen[id] === undefined);
  const candidates = [...stacksIn(manifest, slotId), ...(isOptionalSlot(slot) ? [NO_STACK] : [])];
  return candidates.filter((id) => roleConflict(manifest, { ...chosen, [slotId]: id }, pending) === null);
}

/** The selected stacks, each with its slot, in slot order. */
function selectedApps(manifest: TemplateManifest, stacks: Selection) {
  return Object.entries(stacks).flatMap(([slotId, id]) => {
    const stack = manifest.stacks[id];
    return stack ? [{ slotId, slot: manifest.slots[slotId]!, id, stack }] : [];
  });
}

/**
 * The options of a module the selected stacks can use: every selected stack that implements
 * the module must implement the option. Project-wide modules (local infrastructure,
 * deployment) are not tied to a stack.
 */
export function moduleChoices(manifest: TemplateManifest, stacks: Selection, moduleId: string): string[] {
  const module = manifest.modules[moduleId]!;
  const all = Object.keys(module.options);
  if (module.scope === "project") return all;
  const involved = selectedApps(manifest, stacks).filter(({ stack }) => stack.modules[moduleId]);
  return all.filter((option) => involved.length > 0 && involved.every(({ stack }) => stack.modules[moduleId]!.includes(option)));
}

/**
 * Resolves one option per module from the request and the defaults, then checks that the
 * selected stacks implement each option and that every option's requirements hold, so an
 * invalid combination fails before anything is written. A module left to its default uses the
 * first option the stacks implement when they do not implement the default.
 */
export function selectModules(
  manifest: TemplateManifest,
  requested: Record<string, string> = {},
  stacks: Selection = selectStacks(manifest),
): Selection {
  const unknownModule = Object.keys(requested).find((id) => !manifest.modules[id]);
  if (unknownModule !== undefined) {
    const offered = Object.keys(manifest.modules);
    throw new ModuleError(
      offered.length
        ? `Unknown module "${unknownModule}". This Starter offers: ${offered.join(", ")}.`
        : `This Starter does not offer module choices; remove --${unknownModule}.`,
    );
  }

  const apps = selectedApps(manifest, stacks);
  const selection: Selection = {};
  for (const [id, module] of Object.entries(manifest.modules)) {
    const choices = moduleChoices(manifest, stacks, id);
    const fallback = choices.includes(module.default) ? module.default : (choices[0] ?? module.default);
    const option = requested[id] ?? fallback;
    if (!module.options[option]) {
      throw new ModuleError(
        `Unknown ${id} option "${option}". Choose one of: ${Object.keys(module.options).join(", ")}.`,
      );
    }
    if (!choices.includes(option)) {
      const optionName = `${module.options[option]!.name} (--${id} ${option})`;
      const lacking = apps.find(({ stack }) => stack.modules[id] && !stack.modules[id]!.includes(option));
      throw new ModuleError(
        lacking
          ? `${lacking.stack.name} does not implement ${optionName}. It implements: ${lacking.stack.modules[id]!.join(", ")}.`
          : `No selected app implements ${module.name} (${apps.map(({ stack }) => stack.name).join(", ")}).`,
      );
    }
    selection[id] = option;
  }

  for (const [id, option] of Object.entries(selection)) {
    const { name, requires } = manifest.modules[id]!.options[option]!;
    for (const [requiredModule, allowed] of Object.entries(requires)) {
      if (!allowed.includes(selection[requiredModule]!)) {
        const needed = allowed
          .map((value) => `${manifest.modules[requiredModule]!.options[value]!.name} (--${requiredModule} ${value})`)
          .join(" or ");
        throw new ModuleError(`${name} needs ${needed}.`);
      }
    }
  }
  return selection;
}

/**
 * Where a Starter file lands in the generated project, or null when it belongs to a stack that
 * was not selected. Each selected stack's app moves to its slot's path, and its environment
 * example and Dockerfile move to the slot's locations.
 */
function placement(selected: Array<{ slot: TemplateSlot; stack: TemplateStack }>, others: TemplateStack[]) {
  return (path: string): string | null => {
    for (const { slot, stack } of selected) {
      if (path === stack.envExample) return slot.env.example;
      if (path === stack.dockerfile && slot.dockerfile) return slot.dockerfile;
    }
    for (const { slot, stack } of selected) {
      if (isWithin(path, stack.app)) return slot.path + path.slice(stack.app.length);
    }
    const belongsToOther = others.some(
      (other) => isWithin(path, other.app) || path === other.envExample || path === other.dockerfile,
    );
    return belongsToOther ? null : path;
  };
}

/**
 * Works out which files, packages, and variants the selected module options keep. A slot's own
 * packages, such as the API contract, are kept when the slot is filled.
 */
function resolveModuleFiles(manifest: TemplateManifest, selection: Selection, stacks: Selection) {
  const ownedPaths = new Set<string>();
  const keptPaths = new Set<string>();
  const usedPackages = new Map<string, string>();
  const offeredPackages = new Map<string, string>();
  const variantSources = new Set<string>();
  /** Variant source path to the default file it replaces. */
  const replacements = new Map<string, string>();

  for (const [id, module] of Object.entries(manifest.modules)) {
    for (const [optionId, option] of Object.entries(module.options)) {
      const selected = selection[id] === optionId;
      for (const path of option.files) {
        ownedPaths.add(path);
        if (selected) keptPaths.add(path);
      }
      for (const [name, directory] of Object.entries(option.packages)) {
        offeredPackages.set(name, directory);
        if (selected) usedPackages.set(name, directory);
      }
      for (const [target, variant] of Object.entries(option.replace)) {
        variantSources.add(variant);
        if (selected) replacements.set(variant, target);
      }
    }
  }

  for (const [slotId, slot] of Object.entries(manifest.slots)) {
    for (const [name, directory] of Object.entries(slot.packages)) {
      offeredPackages.set(name, directory);
      if (manifest.stacks[stacks[slotId] ?? ""]) usedPackages.set(name, directory);
    }
  }

  // Selected options set their scripts; scripts only left-out options define are removed.
  const scripts: ScriptChanges = { set: {}, remove: [] };
  const offeredScripts = new Set<string>();
  for (const [id, module] of Object.entries(manifest.modules)) {
    for (const [optionId, option] of Object.entries(module.options)) {
      for (const [name, command] of Object.entries(option.scripts)) {
        offeredScripts.add(name);
        if (selection[id] === optionId) scripts.set[name] = command;
      }
    }
  }
  scripts.remove = [...offeredScripts].filter((name) => !(name in scripts.set));

  const removedPackages = [...offeredPackages].filter(([name]) => !usedPackages.has(name));
  return {
    scripts,
    removedPackageNames: removedPackages.map(([name]) => name),
    removedPackageDirectories: removedPackages.map(([, directory]) => directory),
    replacedTargets: new Set(replacements.values()),
    replacements,
    variantSources,
    isDroppedOwnedPath: (path: string) =>
      [...ownedPaths].some((owned) => isWithin(path, owned)) &&
      ![...keptPaths].some((kept) => isWithin(path, kept)),
  };
}

export function createPlan(input: PlanInput): ScaffoldPlan {
  const { manifest, identity, source } = input;
  const stacks = selectStacks(manifest, input.stacks);
  const selection = selectModules(manifest, input.modules, stacks);
  const selected = selectedApps(manifest, stacks);
  const selectedIds = new Set(selected.map(({ id }) => id));
  const others = Object.entries(manifest.stacks)
    .filter(([id]) => !selectedIds.has(id))
    .map(([, other]) => other);
  const moduleFiles = resolveModuleFiles(manifest, selection, stacks);
  // pnpm audit stops skipping the advisories that only left-out stacks need.
  const neededAdvisories = new Set(selected.flatMap(({ stack }) => stack.auditIgnores ?? []));
  const droppedAdvisories = [...new Set(others.flatMap((other) => other.auditIgnores ?? []))].filter(
    (id) => !neededAdvisories.has(id),
  );

  // A slot is recorded when it offers a choice, so add, remove, and upgrade render the same apps.
  const recorded = selected.filter(
    ({ slotId, slot }) => stacksIn(manifest, slotId).length + (isOptionalSlot(slot) ? 1 : 0) > 1,
  );
  // A slot left empty that would otherwise take its default, such as the framework slot of a
  // project without a web app, is recorded as none, so add, remove, and upgrade leave it empty.
  const recordedSlots = Object.entries(manifest.slots).flatMap(([slotId, slot]) => {
    const app = recorded.find((entry) => entry.slotId === slotId);
    if (app) return [{ slotId, id: app.id, summary: `${slot.name}: ${app.stack.name}` }];
    if (slot.default !== undefined && stacks[slotId] === NO_STACK) return [{ slotId, id: NO_STACK, summary: `${slot.name}: none` }];
    return [];
  });
  const apps = selected.map(({ slotId, slot, id, stack }) => ({ slot: slotId, slotName: slot.name, id, name: stack.name }));
  const modules = Object.entries(selection).map(([id, option]) => ({
    id,
    name: manifest.modules[id]!.name,
    option,
    optionName: manifest.modules[id]!.options[option]!.name,
  }));
  // The apps deploy runs, each with its Dockerfile. A shell runs no server, so it has neither.
  const services = Object.fromEntries(
    selected.flatMap(({ slotId, slot, stack }) =>
      stack.deployment && slot.dockerfile
        ? [[slotId, {
            ...stack.deployment,
            role: stack.role,
            app: slot.path,
            dockerfile: slot.dockerfile,
          }]]
        : [],
    ),
  );
  const provenance: Provenance = {
    cliVersion: input.cliVersion,
    starterRepository: source.repository,
    starterRef: source.ref,
    ...(source.commit ? { starterCommit: source.commit } : {}),
    ...(recordedSlots.length
      ? {
          stacks: Object.fromEntries(recordedSlots.map(({ slotId, id }) => [slotId, id])),
          stackSummary: recordedSlots.map(({ summary }) => summary),
        }
      : {}),
    ...(modules.length
      ? {
          modules: Object.fromEntries(modules.map(({ id, option }) => [id, option])),
          moduleSummary: modules.map(({ name, optionName }) => `${name}: ${optionName}`),
        }
      : {}),
    ...(Object.keys(services).length ? { services } : {}),
  };
  const place = placement(selected, others);
  const envTargets = Object.values(manifest.slots).map((slot) => slot.env.target);

  const files: Array<{ from: string; to: string }> = [];
  for (const file of source.files) {
    const path = file.to;
    if (isExcluded(path, manifest.exclude)) continue;
    let target: string | null = path;
    if (moduleFiles.variantSources.has(path)) {
      // A variant is only ever copied over the default file it replaces.
      const replaced = moduleFiles.replacements.get(path);
      target = replaced === undefined ? null : place(replaced);
    } else if (
      moduleFiles.replacedTargets.has(path) ||
      moduleFiles.isDroppedOwnedPath(path) ||
      moduleFiles.removedPackageDirectories.some((directory) => isWithin(path, directory))
    ) {
      target = null;
    } else {
      target = place(path);
    }
    if (target !== null && !envTargets.includes(target)) files.push({ from: file.from, to: target });
  }
  const has = (path: string) => files.some(({ to }) => to === path);

  const edits: FileEdit[] = [];
  if (has("package.json")) {
    edits.push({
      path: "package.json",
      description: `Name the package "${identity.packageName}" and record its origin`,
      apply: (text) =>
        customizeRootManifest(text, identity, provenance, manifest.dockerImage, moduleFiles.scripts, droppedAdvisories),
    });
  }
  for (const { slot, stack } of selected) {
    const appManifest = `${slot.path}/package.json`;
    const appPackage = slot.package;
    if (appPackage && stack.app !== slot.path && has(appManifest)) {
      edits.push({
        path: appManifest,
        description: `Name the ${stack.name} app "${appPackage}"`,
        apply: (text) => customizeAppManifest(text, appPackage),
      });
    }
  }
  const { removedPackageNames, removedPackageDirectories } = moduleFiles;
  if (removedPackageNames.length) {
    for (const { to } of files) {
      if (to === "package.json" || !to.endsWith("/package.json")) continue;
      edits.push({
        path: to,
        description: `Drop dependencies on left-out packages`,
        apply: (text) => removePackageDependencies(text, removedPackageNames),
      });
    }
  }
  if ((others.length > 0 || removedPackageNames.length) && has(LOCKFILE)) {
    const selectedDirectories = selected.map(({ stack }) => stack.app);
    const changes: LockfileChanges = {
      remove: [
        ...others.map((other) => other.app).filter((app) => !selectedDirectories.includes(app)),
        ...removedPackageDirectories,
      ],
      rename: selected
        .filter(({ slot, stack }) => stack.app !== slot.path)
        .map(({ slot, stack }) => ({ from: stack.app, to: slot.path })),
      removeDependencies: removedPackageNames,
    };
    const names = listNames(selected.map(({ stack }) => stack.name));
    const kept = `${names} app${selected.length > 1 ? "s" : ""}`;
    edits.push({
      path: LOCKFILE,
      description: removedPackageNames.length
        ? `Keep only the ${kept} and the selected modules in the lockfile`
        : `Keep only the ${kept} in the lockfile`,
      apply: (text) => customizeLockfile(text, changes),
    });
  }
  const context: Selection = { ...stacks, ...selection };
  for (const path of manifest.conditional) {
    // A selected variant is edited where it lands, over the default it replaces; the replaced
    // default and the variants left out are not copied at all.
    const replaced = moduleFiles.replacements.get(path);
    const target = replaced !== undefined ? place(replaced) : moduleFiles.replacedTargets.has(path) ? null : place(path);
    if (target === null || !has(target)) continue;
    edits.push({
      path: target,
      description: "Keep the sections for the selected stacks and modules",
      apply: (text) => applyConditionals(text, context, target),
    });
  }
  if (has("README.md")) {
    edits.push({
      path: "README.md",
      description: `Title the README "${identity.displayName}" and record its origin`,
      apply: (text) => customizeReadme(text, identity, provenance),
    });
  }
  if (has(manifest.siteConfig)) {
    edits.push({
      path: manifest.siteConfig,
      description: `Set the project name to "${identity.displayName}"`,
      apply: (text) => customizeSiteConfig(text, identity),
    });
  } else {
    for (const path of legacyBrandedFiles.filter(has)) {
      edits.push({
        path,
        description: `Replace the Starter name with "${identity.displayName}"`,
        apply: (text) => customizeLegacySource(text, identity),
      });
    }
  }
  // Other apps name the project in their own site config, such as the API's health response.
  for (const { slot } of selected) {
    const path = slot.siteConfig;
    if (!path || path === manifest.siteConfig || !has(path)) continue;
    edits.push({
      path,
      description: `Set the project name to "${identity.displayName}"`,
      apply: (text) => customizeSiteConfig(text, identity),
    });
  }

  const envFiles = selected
    .map(({ slot }) => ({ from: slot.env.example, to: slot.env.target }))
    .filter(({ from }) => has(from));
  // The API's env file even when its example is missing, as databaseEnvFile(project) resolves it
  // later from the API's service, so the URLs written at creation are where commands look.
  const apiEnvFile = selected.find(({ stack }) => stack.role === "api")?.slot.env.target;

  return {
    targetDirectory: input.targetDirectory,
    identity,
    provenance,
    apps,
    modules,
    files,
    edits,
    envFiles,
    databaseEnvFile: apiEnvFile ?? envFiles[0]?.to ?? null,
    toolchains: selected.flatMap(({ slot, stack }) =>
      stack.toolchain ? [{ directory: slot.path, app: stack.name, toolchain: stack.toolchain }] : [],
    ),
    git: input.git,
    install: input.install,
  };
}

/** App names in a sentence: "a", "a and b", or "a, b, and c". */
export function listNames(names: string[]): string {
  return names.length > 2 ? `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}` : names.join(" and ");
}

export function describePlan(plan: ScaffoldPlan): string[] {
  const recorded = plan.apps.filter(({ slot }) => plan.provenance.stacks?.[slot]);
  return [
    `Create ${plan.targetDirectory}`,
    ...(recorded.length ? [`Use ${listNames(recorded.map(({ name }) => name))}`] : []),
    ...(plan.modules.length
      ? [`Use ${plan.modules.map(({ name, optionName }) => `${name}: ${optionName}`).join(", ")}`]
      : []),
    `Copy ${plan.files.length} files from ${plan.provenance.starterRepository}@${plan.provenance.starterRef}` +
      (plan.provenance.starterCommit ? ` (${plan.provenance.starterCommit.slice(0, 8)})` : ""),
    ...plan.edits.map((edit) => `Edit ${edit.path}: ${edit.description}`),
    ...plan.envFiles.map((file) => `Create ${file.to} from ${file.from}`),
    plan.git ? "Initialize a Git repository on main" : "Skip Git initialization",
    plan.install ? "Install dependencies with pnpm" : "Skip dependency installation",
    ...(plan.install
      ? plan.toolchains.map(({ directory, app, toolchain }) => `Install the ${app} app's dependencies in ${directory} with ${toolchain.name}`)
      : []),
  ];
}
