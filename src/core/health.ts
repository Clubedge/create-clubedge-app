// Pure checks behind `status` and `doctor`: they take what the commands read from the project,
// the system, and npm, and return what to show, so each can be tested without a real project.
import { envKeys } from "./env.js";
import { isNeonPooledUrl, isNeonUrl, neonEndpoint, type NeonDatabaseState } from "./neon.js";

/** Compares dotted versions such as "v0.13.1" and "0.12.0"; null when either is not one. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
    return match ? match.slice(1).map(Number) : null;
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return 0;
}

export interface LatestRelease {
  cliVersion: string;
  starterRef: string;
}

const REGISTRY_URL = "https://registry.npmjs.org/@clubedge%2fcreate-clubedge-app/latest";

/**
 * The newest published CLI and the Starter release it is pinned to, from npm. Resolves null when
 * npm cannot be reached in time, so status still works offline.
 */
export async function fetchLatestRelease(fetcher: typeof fetch = fetch, timeoutMs = 4_000): Promise<LatestRelease | null> {
  try {
    const response = await fetcher(REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const latest = (await response.json()) as { version?: unknown; clubedge?: { starterRef?: unknown } };
    if (typeof latest.version !== "string" || typeof latest.clubedge?.starterRef !== "string") return null;
    return { cliVersion: latest.version, starterRef: latest.clubedge.starterRef };
  } catch {
    return null;
  }
}

export type GitState = { kind: "clean" } | { kind: "dirty"; files: number } | { kind: "none" };

export type UpdateState =
  | { kind: "current" }
  | { kind: "available"; starterRef: string; cliVersion: string }
  /** npm could not be reached, or the project is on a branch or commit rather than a release. */
  | { kind: "unknown" };

export function updateState(projectRef: string, latest: LatestRelease | null): UpdateState {
  if (!latest) return { kind: "unknown" };
  const difference = compareVersions(latest.starterRef, projectRef);
  if (difference === null) return { kind: "unknown" };
  return difference > 0 ? { kind: "available", ...latest } : { kind: "current" };
}

/** The command that runs the newest CLI in this project. */
export function latestCliCommand(cli: string): string {
  return cli === "pnpm clubedge" ? cli : "pnpm dlx @clubedge/create-clubedge-app@latest";
}

/** What to do next, given the working tree and whether a newer Starter exists. */
export function nextStep(git: GitState, update: UpdateState, cli: string): string {
  if (update.kind === "available") {
    const upgrade = `${latestCliCommand(cli)} upgrade`;
    return git.kind === "dirty"
      ? `Commit or stash your changes, then run \`${upgrade}\` to move to Starter ${update.starterRef}.`
      : `Run \`${upgrade}\` to move to Starter ${update.starterRef}.`;
  }
  if (update.kind === "current") {
    return `The project is on the newest Starter release. Run \`${cli} doctor\` to check its setup.`;
  }
  return `Could not check for a newer Starter release. Run \`${cli} doctor\` to check the project's setup.`;
}

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to do about a warning or failure. */
  fix?: string;
}

/** The lowest version a range such as ">=22.12.0" or "^22.12.0" accepts. */
function minimumOf(range: string | undefined): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(range ?? "");
  return match ? match[1]! : null;
}

export function checkNode(actual: string, engines: string | undefined): CheckResult {
  const minimum = minimumOf(engines) ?? "22.12.0";
  const difference = compareVersions(actual, minimum);
  return difference !== null && difference >= 0
    ? { name: "Node.js", status: "ok", detail: `${actual} (needs ${minimum} or newer)` }
    : {
        name: "Node.js",
        status: "fail",
        detail: `${actual}, but the project needs ${minimum} or newer`,
        fix: `Install Node.js ${minimum} or newer, such as the current LTS release.`,
      };
}

/** Compares pnpm with the version in package.json's packageManager, such as "pnpm@10.9.0". */
export function checkPnpm(actual: string | null, packageManager: string | undefined): CheckResult {
  const pinned = /^pnpm@(\d+\.\d+\.\d+)/.exec(packageManager ?? "")?.[1];
  if (!actual) {
    return {
      name: "pnpm",
      status: "fail",
      detail: "not found",
      fix: "Run `corepack enable`, which installs the pnpm version the project pins.",
    };
  }
  if (!pinned) return { name: "pnpm", status: "ok", detail: actual };
  const difference = compareVersions(actual, pinned);
  return difference !== null && difference >= 0
    ? { name: "pnpm", status: "ok", detail: `${actual} (project pins ${pinned})` }
    : {
        name: "pnpm",
        status: "warn",
        detail: `${actual}, older than the ${pinned} the project pins`,
        fix: "Run `corepack enable` so pnpm follows the project's packageManager field.",
      };
}

/**
 * Compares the local env file with the example: variables the example has and the local file
 * lacks, and variables only the local file sets.
 */
export function checkEnvFile(
  example: string | null,
  local: string | null,
  paths: { example: string; local: string },
): CheckResult {
  const name = "Environment file";
  if (local === null) {
    return {
      name,
      status: "fail",
      detail: `${paths.local} does not exist`,
      fix: `Copy ${paths.example} to ${paths.local} and fill in the values.`,
    };
  }
  if (example === null) return { name, status: "ok", detail: `${paths.local} exists (no ${paths.example} to compare)` };
  const exampleKeys = new Set(envKeys(example));
  const localKeys = new Set(envKeys(local));
  const missing = [...exampleKeys].filter((key) => !localKeys.has(key));
  const unused = [...localKeys].filter((key) => !exampleKeys.has(key));
  if (!missing.length && !unused.length) {
    return { name, status: "ok", detail: `${paths.local} has every variable in ${paths.example}` };
  }
  const parts = [
    missing.length ? `missing ${missing.join(", ")}` : "",
    unused.length ? `not in ${paths.example}: ${unused.join(", ")}` : "",
  ].filter(Boolean);
  return {
    name,
    status: "warn",
    detail: `${paths.local}: ${parts.join("; ")}`,
    fix: missing.length
      ? `Add the missing variables from ${paths.example}; empty values are fine for services you do not use yet.`
      : "Remove variables the project no longer uses, unless your own code reads them.",
  };
}

/** Reads the result of `pnpm install --frozen-lockfile --lockfile-only`. */
export function checkLockfile(error: string | null): CheckResult {
  const name = "Lockfile";
  if (error === null) return { name, status: "ok", detail: "pnpm-lock.yaml matches every package.json" };
  if (error.includes("ERR_PNPM_OUTDATED_LOCKFILE")) {
    return {
      name,
      status: "fail",
      detail: "pnpm-lock.yaml is out of date with a package.json",
      fix: "Run `pnpm install` to update it, then commit pnpm-lock.yaml.",
    };
  }
  return {
    name,
    status: "warn",
    detail: `could not check: ${error.split("\n").find((line) => line.trim()) ?? error}`,
  };
}

/** The database a connection URL names (its path). */
function databaseName(url: string): string {
  try {
    return decodeURIComponent(new URL(url.trim()).pathname.slice(1));
  } catch {
    return "";
  }
}

/**
 * The database URLs in the local env file: Neon's pooled URL for the app and its direct URL for
 * migrations and the jobs worker, and how long a free Neon database the CLI created has left.
 * Null when there is nothing to say (no Neon, no direct URL, and infra isn't neon).
 */
export function checkDatabaseUrls(input: {
  env: Record<string, string>;
  infra: string | undefined;
  /** The free Neon database DATABASE_URL uses, as Neon describes it now, when the CLI created it. */
  claimable: NeonDatabaseState | null;
  cli: string;
  envPath: string;
}): CheckResult | null {
  const { env, infra, claimable, cli, envPath } = input;
  const name = "Database URLs";
  const url = env.DATABASE_URL ?? "";
  const direct = env.DATABASE_URL_DIRECT ?? "";
  if (!url) {
    return infra === "neon"
      ? { name, status: "fail", detail: `DATABASE_URL in ${envPath} is empty`, fix: `Run \`${cli} neon create\` for a free Neon database, or paste your Neon project's pooled URL.` }
      : null;
  }
  if (direct && isNeonPooledUrl(direct)) {
    return { name, status: "fail", detail: "DATABASE_URL_DIRECT points at Neon's pooler", fix: "Use the same URL without -pooler in the host: migrations and the jobs worker need a direct session." };
  }
  if (claimable?.kind === "expired") {
    return { name, status: "fail", detail: "the free Neon database in DATABASE_URL expired, and Neon deleted it", fix: `Run \`${cli} neon create\`, then \`pnpm db:migrate\`.` };
  }
  if (!isNeonUrl(url)) {
    return direct ? { name, status: "ok", detail: "DATABASE_URL for the app, DATABASE_URL_DIRECT for migrations and the jobs worker" } : null;
  }
  if (!isNeonPooledUrl(url)) {
    return { name, status: "warn", detail: "DATABASE_URL is Neon's direct host, which has fewer connections", fix: "Put the pooled URL (the host with -pooler) in DATABASE_URL, and this one in DATABASE_URL_DIRECT." };
  }
  if (!direct) {
    return { name, status: "warn", detail: "DATABASE_URL is Neon's pooler, and DATABASE_URL_DIRECT is not set", fix: "Set DATABASE_URL_DIRECT to the same URL without -pooler in the host, for migrations and the jobs worker." };
  }
  if (neonEndpoint(direct) !== neonEndpoint(url) || databaseName(direct) !== databaseName(url)) {
    return { name, status: "warn", detail: "DATABASE_URL and DATABASE_URL_DIRECT point at different Neon databases", fix: "Copy both from the same branch in the Neon console: pooled and direct." };
  }
  if (claimable?.kind === "unclaimed") {
    const detail = `a free Neon database, unclaimed: ${claimable.hoursLeft} hours left`;
    return claimable.hoursLeft < 24
      ? { name, status: "warn", detail, fix: `Keep it with \`${cli} neon claim\`, or Neon deletes it with its data.` }
      : { name, status: "ok", detail: `${detail} (\`${cli} neon claim\` keeps it)` };
  }
  return { name, status: "ok", detail: "Neon, pooled for the app and direct for migrations and the jobs worker" };
}

export interface ConflictedFile {
  path: string;
  blocks: number;
}

export function checkConflicts(conflicts: ConflictedFile[]): CheckResult {
  const name = "Conflicts";
  if (!conflicts.length) return { name, status: "ok", detail: "no unresolved conflict markers" };
  const total = conflicts.reduce((sum, c) => sum + c.blocks, 0);
  const sample = conflicts
    .slice(0, 5)
    .map((c) => `\n  • ${c.path} (${c.blocks} ${c.blocks === 1 ? "block" : "blocks"})`)
    .join("");
  const more = conflicts.length > 5 ? `\n  ... and ${conflicts.length - 5} more files` : "";
  return {
    name,
    status: "fail",
    detail: `${conflicts.length} ${conflicts.length === 1 ? "file has" : "files have"} unresolved conflict markers (${total} total):${sample}${more}`,
    fix: 'Resolve the "<<<<<<< yours" markers in these files, then delete .clubedge/incoming.',
  };
}

