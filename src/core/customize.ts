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
  const origin =
    `## Generated from\n\n` +
    `- Starter repository: \`${provenance.starterRepository}\`\n` +
    `- Starter ref: \`${provenance.starterRef}\`${commitLine}\n` +
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
