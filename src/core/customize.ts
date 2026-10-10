// Pure text transforms applied to template files. Keeping them free of I/O makes each one easy
// to test and lets --dry-run describe them without touching the disk.

export interface ProjectIdentity {
  packageName: string;
  displayName: string;
}

/** Recorded in the generated package.json and README so a project can trace its origin. */
export interface Provenance {
  cliVersion: string;
  starterRepository: string;
  starterRef: string;
  starterCommit?: string;
  /** The framework id chosen for the project, such as "tanstack-start". */
  framework?: string;
  /** Its display name, for the README. */
  frameworkName?: string;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export function customizeRootManifest(
  source: string,
  { packageName }: ProjectIdentity,
  provenance: Provenance,
  dockerImage: string,
): string {
  const manifest = JSON.parse(source);
  manifest.name = packageName;
  manifest.clubedge = {
    cliVersion: provenance.cliVersion,
    starterRepository: provenance.starterRepository,
    starterRef: provenance.starterRef,
    ...(provenance.starterCommit ? { starterCommit: provenance.starterCommit } : {}),
    ...(provenance.framework ? { framework: provenance.framework } : {}),
  };

  for (const script of ["docker:build", "docker:start"]) {
    if (typeof manifest.scripts?.[script] === "string") {
      manifest.scripts[script] = manifest.scripts[script].replaceAll(dockerImage, packageName);
    }
  }
  return json(manifest);
}

export function customizeReadme(
  source: string,
  { displayName }: ProjectIdentity,
  provenance: Provenance,
): string {
  const commitLine = provenance.starterCommit
    ? `\n- Starter commit: \`${provenance.starterCommit}\``
    : "";
  const frameworkLine = provenance.frameworkName ? `\n- Framework: ${provenance.frameworkName}` : "";
  const origin =
    `## Generated from\n\n` +
    `- Starter repository: \`${provenance.starterRepository}\`\n` +
    `- Starter ref: \`${provenance.starterRef}\`${commitLine}${frameworkLine}\n` +
    `- CLI version: \`${provenance.cliVersion}\``;

  // Only the first heading is the project title; leave every other line as written.
  return source.replace(/^# .+$/m, `# ${displayName}\n\n${origin}`);
}

export function customizeSiteConfig(source: string, { packageName, displayName }: ProjectIdentity): string {
  const siteConfig = JSON.parse(source);
  siteConfig.name = displayName;
  siteConfig.shortName = displayName;
  siteConfig.description = `${displayName} application foundation.`;
  siteConfig.serviceId = packageName;
  siteConfig.workspaceLabel = "Application workspace";
  return json(siteConfig);
}

/** Starter v0.1.x has no site config; these files carried the project name instead. */
export const legacyBrandedFiles = [
  "apps/web/src/app/layout.tsx",
  "apps/web/src/app/page.tsx",
  "apps/web/src/app/dashboard/_components/app-sidebar.tsx",
  "apps/web/src/app/dashboard/page.tsx",
  "apps/web/src/app/login/page.tsx",
];

export function customizeLegacySource(source: string, { displayName }: ProjectIdentity): string {
  return source
    .replaceAll('"Clubedge Starter"', JSON.stringify(displayName))
    .replace("%s · Clubedge Starter", `%s · ${displayName}`)
    .replace(
      "A production-minded foundation for Clubedge applications.",
      `${displayName} application foundation.`,
    )
    .replaceAll("Clubedge Starter", displayName)
    .replaceAll(">Clubedge<", `>${displayName}<`)
    .replaceAll("Starter workspace", "Application workspace");
}

/** Gives the selected framework's app the package name generated projects use. */
export function customizeAppManifest(source: string, appPackage: string): string {
  const manifest = JSON.parse(source);
  manifest.name = appPackage;
  return json(manifest);
}

export interface LockfileChanges {
  /** Workspace importers to drop: the apps of frameworks that were not selected. */
  remove: string[];
  /** The selected app's importer, renamed to its location in the generated project. */
  rename?: { from: string; to: string };
}

/**
 * Keeps pnpm-lock.yaml in step with the selected framework so `pnpm install --frozen-lockfile`
 * works. Importers are keyed by workspace path at two-space indentation; package entries that
 * are no longer used are harmless, and pnpm prunes them on the next lockfile update.
 */
export function customizeLockfile(source: string, { remove, rename }: LockfileChanges): string {
  const output: string[] = [];
  let inImporters = false;
  let skipping = false;

  for (const line of source.split("\n")) {
    if (/^\S/.test(line)) {
      inImporters = line === "importers:";
      skipping = false;
    } else if (inImporters) {
      // An importer key, with its value on the next lines or inline ("packages/core: {}").
      const key = /^ {2}([^\s:][^:]*):(?: |$)/.exec(line)?.[1];
      if (key !== undefined) {
        skipping = remove.includes(key);
        if (!skipping && key === rename?.from) {
          output.push(`  ${rename.to}:`);
          continue;
        }
      }
      if (skipping) continue;
    }
    output.push(line);
  }
  return output.join("\n");
}
