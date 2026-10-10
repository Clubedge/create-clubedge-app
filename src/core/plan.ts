import {
  customizeAppManifest,
  customizeLegacySource,
  customizeLockfile,
  customizeReadme,
  customizeRootManifest,
  customizeSiteConfig,
  legacyBrandedFiles,
  type LockfileChanges,
  type ProjectIdentity,
  type Provenance,
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
  cliVersion: string;
  git: boolean;
  install: boolean;
}

export class FrameworkError extends Error {
  override name = "FrameworkError";
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

export function createPlan(input: PlanInput): ScaffoldPlan {
  const { manifest, identity, source } = input;
  const framework = selectFramework(manifest, input.framework);
  const others = Object.entries(manifest.frameworks)
    .filter(([id]) => id !== framework.id)
    .map(([, other]) => other);
  const multipleFrameworks = others.length > 0;

  const provenance: Provenance = {
    cliVersion: input.cliVersion,
    starterRepository: source.repository,
    starterRef: source.ref,
    ...(source.commit ? { starterCommit: source.commit } : {}),
    ...(multipleFrameworks ? { framework: framework.id, frameworkName: framework.name } : {}),
  };

  const files: Array<{ from: string; to: string }> = [];
  for (const file of source.files) {
    if (isExcluded(file.to, manifest.exclude)) continue;
    const to = relocate(file.to, manifest, framework, others);
    if (to !== null && to !== manifest.env.target) files.push({ from: file.from, to });
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
  if (multipleFrameworks && has(LOCKFILE)) {
    const changes: LockfileChanges = {
      remove: others.map((other) => other.app).filter((app) => app !== framework.app),
      ...(framework.app !== manifest.app ? { rename: { from: framework.app, to: manifest.app } } : {}),
    };
    edits.push({
      path: LOCKFILE,
      description: `Keep only the ${framework.name} app in the lockfile`,
      apply: (text) => customizeLockfile(text, changes),
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
    `Copy ${plan.files.length} files from ${plan.provenance.starterRepository}@${plan.provenance.starterRef}` +
      (plan.provenance.starterCommit ? ` (${plan.provenance.starterCommit.slice(0, 8)})` : ""),
    ...plan.edits.map((edit) => `Edit ${edit.path}: ${edit.description}`),
    ...(plan.envFile ? [`Create ${plan.envFile.to} from ${plan.envFile.from}`] : []),
    plan.git ? "Initialize a Git repository on main" : "Skip Git initialization",
    plan.install ? "Install dependencies with pnpm" : "Skip dependency installation",
  ];
}
