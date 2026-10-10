import {
  customizeLegacySource,
  customizeReadme,
  customizeRootManifest,
  customizeSiteConfig,
  legacyBrandedFiles,
  type ProjectIdentity,
  type Provenance,
} from "./customize.js";
import type { TemplateManifest } from "./manifest.js";
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
  cliVersion: string;
  git: boolean;
  install: boolean;
}

function isExcluded(path: string, exclude: string[]): boolean {
  return exclude.some((entry) => path === entry || path.startsWith(`${entry.replace(/\/$/, "")}/`));
}

export function createPlan(input: PlanInput): ScaffoldPlan {
  const { manifest, identity, source } = input;
  const provenance: Provenance = {
    cliVersion: input.cliVersion,
    starterRepository: source.repository,
    starterRef: source.ref,
    ...(source.commit ? { starterCommit: source.commit } : {}),
  };

  const files = source.files.filter(
    ({ to }) => !isExcluded(to, manifest.exclude) && to !== manifest.env.target,
  );
  const has = (path: string) => files.some(({ to }) => to === path);

  const edits: FileEdit[] = [];
  if (has("package.json")) {
    edits.push({
      path: "package.json",
      description: `Name the package "${identity.packageName}" and record its origin`,
      apply: (text) => customizeRootManifest(text, identity, provenance, manifest.dockerImage),
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
    `Copy ${plan.files.length} files from ${plan.provenance.starterRepository}@${plan.provenance.starterRef}` +
      (plan.provenance.starterCommit ? ` (${plan.provenance.starterCommit.slice(0, 8)})` : ""),
    ...plan.edits.map((edit) => `Edit ${edit.path}: ${edit.description}`),
    ...(plan.envFile ? [`Create ${plan.envFile.to} from ${plan.envFile.from}`] : []),
    plan.git ? "Initialize a Git repository on main" : "Skip Git initialization",
    plan.install ? "Install dependencies with pnpm" : "Skip dependency installation",
  ];
}
