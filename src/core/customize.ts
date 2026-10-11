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
  /** The selected option per module, such as `{ auth: "none" }`. */
  modules?: Record<string, string>;
  /** Readable module choices for the README, such as `Authentication: None`. */
  moduleSummary?: string[];
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Root package.json scripts that module options set or that left-out options remove. */
export interface ScriptChanges {
  set: Record<string, string>;
  remove: string[];
}

export function customizeRootManifest(
  source: string,
  { packageName }: ProjectIdentity,
  provenance: Provenance,
  dockerImage: string,
  scripts: ScriptChanges = { set: {}, remove: [] },
): string {
  const manifest = JSON.parse(source);
  manifest.name = packageName;
  if (manifest.scripts && typeof manifest.scripts === "object") {
    for (const name of scripts.remove) delete manifest.scripts[name];
  }
  if (Object.keys(scripts.set).length) manifest.scripts = { ...manifest.scripts, ...scripts.set };
  manifest.clubedge = {
    cliVersion: provenance.cliVersion,
    starterRepository: provenance.starterRepository,
    starterRef: provenance.starterRef,
    ...(provenance.starterCommit ? { starterCommit: provenance.starterCommit } : {}),
    ...(provenance.framework ? { framework: provenance.framework } : {}),
    ...(provenance.modules ? { modules: provenance.modules } : {}),
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
  const modulesLine = provenance.moduleSummary?.length
    ? `\n- Modules: ${provenance.moduleSummary.join(", ")}`
    : "";
  const origin =
    `## Generated from\n\n` +
    `- Starter repository: \`${provenance.starterRepository}\`\n` +
    `- Starter ref: \`${provenance.starterRef}\`${commitLine}${frameworkLine}${modulesLine}\n` +
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
  /** Workspace importers to drop: unselected framework apps and left-out packages. */
  remove: string[];
  /** The selected app's importer, renamed to its location in the generated project. */
  rename?: { from: string; to: string };
  /** Dependencies to drop from every remaining importer: the left-out workspace packages. */
  removeDependencies?: string[];
}

/**
 * Keeps pnpm-lock.yaml in step with the selected framework so `pnpm install --frozen-lockfile`
 * works. Importers are keyed by workspace path at two-space indentation; package entries that
 * are no longer used are harmless, and pnpm prunes them on the next lockfile update.
 */
export function customizeLockfile(
  source: string,
  { remove, rename, removeDependencies = [] }: LockfileChanges,
): string {
  const output: string[] = [];
  let inImporters = false;
  let skippingImporter = false;
  let skippingDependency = false;
  // A dependency group header ("    dependencies:") is held until it gets an entry, so a group
  // whose entries were all removed disappears instead of becoming an empty YAML value.
  let pendingGroup: string | null = null;

  for (const line of source.split("\n")) {
    if (/^\S/.test(line)) {
      inImporters = line === "importers:";
      skippingImporter = skippingDependency = false;
      pendingGroup = null;
      output.push(line);
      continue;
    }
    if (!inImporters) {
      output.push(line);
      continue;
    }

    // An importer key, with its value on the next lines or inline ("packages/core: {}").
    const importer = /^ {2}([^\s:][^:]*):(?: |$)/.exec(line)?.[1];
    if (importer !== undefined) {
      skippingImporter = remove.includes(importer);
      skippingDependency = false;
      pendingGroup = null;
      if (!skippingImporter) output.push(importer === rename?.from ? `  ${rename.to}:` : line);
      continue;
    }
    if (skippingImporter) continue;

    if (/^ {4}\S/.test(line)) {
      skippingDependency = false;
      pendingGroup = line;
      continue;
    }
    const dependency = /^ {6}(['"]?)([^'":]+)\1:\s*$/.exec(line)?.[2];
    if (dependency !== undefined) {
      skippingDependency = removeDependencies.includes(dependency);
      if (skippingDependency) continue;
      if (pendingGroup !== null) {
        output.push(pendingGroup);
        pendingGroup = null;
      }
      output.push(line);
      continue;
    }
    if (skippingDependency && /^ {8}/.test(line)) continue;
    if (pendingGroup !== null && line.trim() !== "") {
      output.push(pendingGroup);
      pendingGroup = null;
    }
    skippingDependency = false;
    output.push(line);
  }
  return output.join("\n");
}

/** The selected framework and module options, as `{ framework: "next", auth: "none", ... }`. */
export type Selection = Record<string, string>;

export class ConditionalError extends Error {
  override name = "ConditionalError";
}

// A marker line in any comment style the Starter uses: //, #, %% (Mermaid), <!-- -->, /* */,
// or {/* */}.
const MARKER = /^\s*(?:\/\/|#|%%|<!--|\{?\/\*)\s*clubedge:(if|end)\b\s*(.*?)\s*(?:-->|\*\/\}?)?\s*$/;
// A single line kept only when its condition holds: "- Item <!-- clubedge:only auth=supabase -->".
const LINE_MARKER = /\s*(?:\/\/|#|<!--|\{?\/\*)\s*clubedge:only\s+(.+?)\s*(?:-->|\*\/\}?)?\s*$/;

function evaluateCondition(expression: string, selection: Selection, location: string): boolean {
  // Maintainer-only sections of the Starter repository never reach a generated project.
  if (expression.trim() === "starter-repository") return false;
  return expression.split("&&").every((part) => {
    const match = /^\s*([a-z][a-z0-9-]*)\s*(!?=)\s*([a-z0-9|-]+)\s*$/.exec(part);
    if (!match) throw new ConditionalError(`${location}: cannot read the condition "${expression}".`);
    const [, key, operator, values] = match;
    const selected = selection[key!];
    if (selected === undefined) throw new ConditionalError(`${location}: unknown key "${key}".`);
    const matches = values!.split("|").includes(selected);
    return operator === "=" ? matches : !matches;
  });
}

/**
 * Keeps or drops `clubedge:if <condition>` ... `clubedge:end` blocks for the selection and
 * always removes the marker lines. Conditions look like `auth=none`, `storage!=none`,
 * `auth=supabase|better-auth`, or several joined with `&&`. Blocks do not nest.
 */
export function applyConditionals(source: string, selection: Selection, path = "file"): string {
  const output: string[] = [];
  let open: { keep: boolean; line: number } | null = null;
  let removed = false;

  source.split("\n").forEach((line, index) => {
    const marker = MARKER.exec(line);
    const location = `${path}:${index + 1}`;
    if (marker?.[1] === "if") {
      if (open) throw new ConditionalError(`${location}: clubedge:if blocks cannot nest.`);
      open = { keep: evaluateCondition(marker[2] ?? "", selection, location), line: index + 1 };
      removed = removed || !open.keep;
      return;
    }
    if (marker?.[1] === "end") {
      if (!open) throw new ConditionalError(`${location}: clubedge:end without clubedge:if.`);
      open = null;
      return;
    }
    if (open && !open.keep) return;
    const lineMarker = LINE_MARKER.exec(line);
    if (lineMarker && line.trim() !== lineMarker[0].trim()) {
      if (!evaluateCondition(lineMarker[1]!, selection, location)) {
        removed = true;
        return;
      }
      output.push(line.slice(0, lineMarker.index));
      return;
    }
    output.push(line);
  });

  if (open) throw new ConditionalError(`${path}:${(open as { line: number }).line}: clubedge:if is never closed.`);
  const text = output.join("\n");
  if (!removed) return text;
  // A removed block can leave two blank lines in a row, or blank lines at the start or end of
  // the file; formatted sources never have them.
  const collapsed = text.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  return source.endsWith("\n") ? collapsed.replace(/\n+$/, "\n") : collapsed;
}

/** Removes dependencies on workspace packages that were left out of the project. */
export function removePackageDependencies(source: string, names: string[]): string {
  const manifest = JSON.parse(source);
  let changed = false;
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const dependencies = manifest[field];
    if (!dependencies || typeof dependencies !== "object") continue;
    for (const name of names) {
      if (name in dependencies) {
        delete dependencies[name];
        changed = true;
      }
    }
  }
  return changed ? json(manifest) : source;
}
