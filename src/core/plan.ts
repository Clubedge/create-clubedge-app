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
  type Selection,
} from "./customize.js";
import type { FrameworkTemplate, TemplateManifest } from "./manifest.js";
import type { TemplateSource } from "./source.js";

export interface FileEdit {
  path: string;
  description: string;
  apply(source: string): string;
}

/** Everything the CLI will do, decided before anything is written. */
export interface ScaffoldPlan {
  targetDirectory: string;
  identity: ProjectIdentity;
  provenance: Provenance;
  framework: { id: string; name: string };
  /** The selected option per module, with display names. Empty before schema 3. */
  modules: Array<{ id: string; name: string; option: string; optionName: string }>;
  files: Array<{ from: string; to: string }>;
  edits: FileEdit[];
  /** The environment example copied to the app's local env file, when the template has one. */
  envFile: { from: string; to: string } | null;
  git: boolean;
  install: boolean;
}

export interface PlanInput {
  targetDirectory: string;
  identity: ProjectIdentity;
  source: Pick<TemplateSource, "files" | "repository" | "ref" | "commit">;
  manifest: TemplateManifest;
  /** A framework id from the manifest; defaults to the manifest's default framework. */
  framework?: string;
  /** Requested module options by module id; unlisted modules use their defaults. */
  modules?: Record<string, string>;
  cliVersion: string;
  git: boolean;
  install: boolean;
}

export class FrameworkError extends Error {
  override name = "FrameworkError";
}

export class ModuleError extends Error {
  override name = "ModuleError";
}

const LOCKFILE = "pnpm-lock.yaml";

const isWithin = (path: string, directory: string) =>
  path === directory || path.startsWith(`${directory.replace(/\/$/, "")}/`);

function isExcluded(path: string, exclude: string[]): boolean {
  return exclude.some((entry) => isWithin(path, entry));
}

/** Resolves the requested framework, or the default, with a helpful error for unknown ids. */
export function selectFramework(manifest: TemplateManifest, requested?: string) {
  const id = requested ?? manifest.defaultFramework;
  const framework = manifest.frameworks[id];
  if (!framework) {
    const choices = Object.keys(manifest.frameworks).join(", ");
    throw new FrameworkError(`Unknown framework "${id}". This Starter offers: ${choices}.`);
  }
  return { id, ...framework };
}

/**
 * Resolves one option per module from the request and the defaults, then checks every
 * option's requirements, so an invalid combination fails before anything is written.
 */
export function selectModules(manifest: TemplateManifest, requested: Record<string, string> = {}): Selection {
  const unknownModule = Object.keys(requested).find((id) => !manifest.modules[id]);
  if (unknownModule !== undefined) {
    const offered = Object.keys(manifest.modules);
    throw new ModuleError(
      offered.length
        ? `Unknown module "${unknownModule}". This Starter offers: ${offered.join(", ")}.`
        : `This Starter does not offer module choices; remove --${unknownModule}.`,
    );
  }

  const selection: Selection = {};
  for (const [id, module] of Object.entries(manifest.modules)) {
    const option = requested[id] ?? module.default;
    if (!module.options[option]) {
      throw new ModuleError(
        `Unknown ${id} option "${option}". Choose one of: ${Object.keys(module.options).join(", ")}.`,
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
 * Where a Starter file lands in the generated project, or null when it belongs to a framework
 * that was not selected. The selected app moves to `manifest.app`, and its environment example
 * and Dockerfile move to the generated project's locations.
 */
function relocate(
  path: string,
  manifest: TemplateManifest,
  selected: FrameworkTemplate,
  others: FrameworkTemplate[],
): string | null {
  if (path === selected.envExample) return manifest.env.example;
  if (path === selected.dockerfile) return "Dockerfile";
  if (isWithin(path, selected.app)) return manifest.app + path.slice(selected.app.length);
  const belongsToOther = others.some(
    (other) => isWithin(path, other.app) || path === other.envExample || path === other.dockerfile,
  );
  return belongsToOther ? null : path;
}

/** Works out which files, packages, and variants the selected module options keep. */
function resolveModuleFiles(manifest: TemplateManifest, selection: Selection) {
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

  const removedPackages = [...offeredPackages].filter(([name]) => !usedPackages.has(name));
  return {
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
  const framework = selectFramework(manifest, input.framework);
  const selection = selectModules(manifest, input.modules);
  const others = Object.entries(manifest.frameworks)
    .filter(([id]) => id !== framework.id)
    .map(([, other]) => other);
  const multipleFrameworks = others.length > 0;
  const moduleFiles = resolveModuleFiles(manifest, selection);

  const modules = Object.entries(selection).map(([id, option]) => ({
    id,
    name: manifest.modules[id]!.name,
    option,
    optionName: manifest.modules[id]!.options[option]!.name,
  }));
  const provenance: Provenance = {
    cliVersion: input.cliVersion,
    starterRepository: source.repository,
    starterRef: source.ref,
    ...(source.commit ? { starterCommit: source.commit } : {}),
    ...(multipleFrameworks ? { framework: framework.id, frameworkName: framework.name } : {}),
    ...(modules.length
      ? {
          modules: Object.fromEntries(modules.map(({ id, option }) => [id, option])),
          moduleSummary: modules.map(({ name, optionName }) => `${name}: ${optionName}`),
        }
      : {}),
  };
  const place = (path: string) => relocate(path, manifest, framework, others);

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
    if (target !== null && target !== manifest.env.target) files.push({ from: file.from, to: target });
  }
  const has = (path: string) => files.some(({ to }) => to === path);

  const edits: FileEdit[] = [];
  if (has("package.json")) {
    edits.push({
      path: "package.json",
      description: `Name the package "${identity.packageName}" and record its origin`,
      apply: (text) => customizeRootManifest(text, identity, provenance, manifest.dockerImage),
    });
  }
  const appManifest = `${manifest.app}/package.json`;
  if (manifest.appPackage && framework.app !== manifest.app && has(appManifest)) {
    const appPackage = manifest.appPackage;
    edits.push({
      path: appManifest,
      description: `Name the ${framework.name} app "${appPackage}"`,
      apply: (text) => customizeAppManifest(text, appPackage),
    });
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
  if ((multipleFrameworks || removedPackageNames.length) && has(LOCKFILE)) {
    const changes: LockfileChanges = {
      remove: [...others.map((other) => other.app).filter((app) => app !== framework.app), ...removedPackageDirectories],
      ...(framework.app !== manifest.app ? { rename: { from: framework.app, to: manifest.app } } : {}),
      removeDependencies: removedPackageNames,
    };
    edits.push({
      path: LOCKFILE,
      description: removedPackageNames.length
        ? `Keep only the ${framework.name} app and the selected modules in the lockfile`
        : `Keep only the ${framework.name} app in the lockfile`,
      apply: (text) => customizeLockfile(text, changes),
    });
  }
  const context: Selection = { framework: framework.id, ...selection };
  for (const path of manifest.conditional) {
    const target = moduleFiles.replacedTargets.has(path) ? null : place(path);
    if (target === null || !has(target)) continue;
    edits.push({
      path: target,
      description: "Keep the sections for the selected framework and modules",
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

  return {
    targetDirectory: input.targetDirectory,
    identity,
    provenance,
    framework: { id: framework.id, name: framework.name },
    modules,
    files,
    edits,
    envFile: has(manifest.env.example) ? { from: manifest.env.example, to: manifest.env.target } : null,
    git: input.git,
    install: input.install,
  };
}

export function describePlan(plan: ScaffoldPlan): string[] {
  return [
    `Create ${plan.targetDirectory}`,
    ...(plan.provenance.framework ? [`Use ${plan.framework.name}`] : []),
    ...(plan.modules.length
      ? [`Use ${plan.modules.map(({ name, optionName }) => `${name}: ${optionName}`).join(", ")}`]
      : []),
    `Copy ${plan.files.length} files from ${plan.provenance.starterRepository}@${plan.provenance.starterRef}` +
      (plan.provenance.starterCommit ? ` (${plan.provenance.starterCommit.slice(0, 8)})` : ""),
    ...plan.edits.map((edit) => `Edit ${edit.path}: ${edit.description}`),
    ...(plan.envFile ? [`Create ${plan.envFile.to} from ${plan.envFile.from}`] : []),
    plan.git ? "Initialize a Git repository on main" : "Skip Git initialization",
    plan.install ? "Install dependencies with pnpm" : "Skip dependency installation",
  ];
}
