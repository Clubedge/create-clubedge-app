// What `deploy` sets up on Railway for a project, as pure functions: the service name, the
// production variables, and reading the Railway CLI's output. src/deploy.ts runs the CLI.

/** The port the production image listens on (the Starter's Dockerfile sets PORT=3000). */
export const appPort = 3000;

/** Railway's names for the databases `railway add --database` creates, used in references. */
export const railwayDatabases = { postgres: "Postgres", redis: "Redis" } as const;

/** A Railway service name from the package name: lowercase letters, digits, and dashes. */
export function serviceName(packageName: string): string {
  const name = packageName.replace(/^@[^/]+\//, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return name || "web";
}

/** The databases a project needs on Railway: Postgres always (Drizzle), Redis with the redis cache. */
export function databasesFor(modules: Record<string, string>): Array<keyof typeof railwayDatabases> {
  return modules.cache === "redis" ? ["postgres", "redis"] : ["postgres"];
}

/** The variable names a project's .env.example lists, in order. */
export function exampleKeys(example: string): string[] {
  const keys = example
    .split(/\r?\n/)
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line.trim())?.[1])
    .filter((key): key is string => Boolean(key));
  return [...new Set(keys)];
}

/** KEY=value lines of an env file; quotes around a value are removed, comments skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[2]!.trim();
    // A quoted value keeps everything inside the quotes, and may still have a comment after them.
    const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(raw);
    values[match[1]!] = quoted ? quoted[2]! : raw.replace(/\s+#.*$/, "");
  }
  return values;
}

export interface VariablePlan {
  /** What `railway variable set` receives, in order. */
  set: Record<string, string>;
  /** Variables the example lists that nothing sets: provider keys and optional settings. */
  unset: string[];
}

/**
 * The service's production variables. The CLI provides what it can: references to Railway's
 * databases, a generated Better Auth secret (unless the service already has one), the public URL,
 * and the port. Values from --env-file come next and win over those, except the database
 * references, which must point at Railway's databases. Everything else the example lists is
 * reported as unset; values the service already has count as set.
 */
export function planVariables(input: {
  modules: Record<string, string>;
  keys: string[];
  url: string;
  existing: Record<string, string>;
  envFile: Record<string, string>;
  secret: () => string;
  /** The database variables' values; by default references to Railway's Postgres and Redis. */
  databases?: Record<string, string>;
  /** Variables the platform sets itself (Fly's `postgres attach` sets DATABASE_URL). */
  attached?: string[];
}): VariablePlan {
  const { modules, keys, url, envFile, secret, attached = [] } = input;
  const existing = { ...input.existing, ...Object.fromEntries(attached.map((key) => [key, "(attached)"])) };
  const reference = (database: string, variable: string) => `\${{${database}.${variable}}}`;
  const databases = input.databases ?? {
    DATABASE_URL: reference(railwayDatabases.postgres, "DATABASE_URL"),
    ...(modules.cache === "redis" ? { REDIS_URL: reference(railwayDatabases.redis, "REDIS_URL") } : {}),
  };
  const provided: Record<string, string> = { NODE_ENV: "production", PORT: String(appPort), ...databases };
  // The public URL under both names: TanStack Start reads APP_URL, Next.js NEXT_PUBLIC_APP_URL.
  const set: Record<string, string> = { ...provided, APP_URL: url, NEXT_PUBLIC_APP_URL: url };
  if (modules.auth === "better-auth" && !existing.BETTER_AUTH_SECRET) set.BETTER_AUTH_SECRET = secret();

  for (const [key, value] of Object.entries(envFile)) {
    if (key === "DATABASE_URL" || key === "REDIS_URL" || value === "") continue;
    set[key] = value;
  }
  const unset = keys.filter((key) => set[key] === undefined && !existing[key]);
  return { set, unset };
}

/** The public domain in `railway domain` output (JSON or text). */
export function parseRailwayDomain(output: string): string | null {
  const domain = /([a-z0-9-]+(?:\.[a-z0-9-]+)*\.up\.railway\.app)/i.exec(output)?.[1];
  return domain ? domain.toLowerCase() : null;
}

/** The service names in `railway status --json`, wherever the CLI puts them. */
export function serviceNames(status: unknown): string[] {
  const names = new Set<string>();
  const visit = (value: unknown, inServices: boolean) => {
    if (Array.isArray(value)) return value.forEach((item) => visit(item, inServices));
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (inServices && key === "name" && typeof child === "string") names.add(child);
      visit(child, inServices || key === "services");
    }
  };
  visit(status, false);
  return [...names];
}

/** `railway variable list --json`: a KEY -> value object, or an array of { name, value }. */
export function parseVariables(output: string): Record<string, string> {
  try {
    const value = JSON.parse(output) as unknown;
    if (Array.isArray(value)) {
      return Object.fromEntries(
        value
          .filter((item): item is { name: string; value: unknown } => typeof item?.name === "string")
          .map((item) => [item.name, String(item.value ?? "")]),
      );
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, String(child ?? "")]));
    }
  } catch {
    // Not JSON: no variables known.
  }
  return {};
}

/** Deployment statuses Railway does not move on from. */
export const finalStatuses = ["SUCCESS", "FAILED", "CRASHED", "REMOVED", "SKIPPED"] as const;

/** The deployment `railway up` started, from the dashboard link it prints (`...?id=<uuid>`). */
export function parseDeploymentId(output: string): string | null {
  return /[?&]id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(output)?.[1] ?? null;
}

/**
 * A deployment's status from `railway deployment list --json` (newest first): the one with `id`,
 * or else the newest created at or after `since`. Null while Railway does not list it yet.
 */
export function deploymentStatus(output: string, id: string | null, since: Date): { id: string; status: string } | null {
  let list: unknown;
  try {
    list = JSON.parse(output);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const deployments = list.filter(
    (item): item is { id: string; status: string; createdAt?: string } => typeof item?.id === "string" && typeof item?.status === "string",
  );
  const found = id
    ? deployments.find((deployment) => deployment.id === id)
    : deployments.find((deployment) => deployment.createdAt && new Date(deployment.createdAt).getTime() >= since.getTime() - 5_000);
  return found ? { id: found.id, status: found.status } : null;
}

/** The oldest Railway CLI that applies `.railway/railway.ts`: its IaC engine ships in the CLI. */
export const minimumRailwayCli = [5, 42, 1] as const;

/** The version in `railway --version` output, such as "railway 5.67.1". */
export function railwayCliVersion(output: string): [number, number, number] | null {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function meetsMinimumCli(version: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i]! !== minimumRailwayCli[i]) return version[i]! > minimumRailwayCli[i]!;
  }
  return true;
}

export const railwayIacPath = ".railway/railway.ts";

/**
 * The project's Railway configuration as code (`.railway/railway.ts`), which replaces railway.json:
 * Railway stops reading railway.json on 2026-12-01. Railway builds the root Dockerfile by itself,
 * the variables stay managed by `deploy` and the dashboard, and the region is Railway's default.
 */
export function railwayIacSource(service: string): string {
  const name = JSON.stringify(service);
  return `// Railway's configuration for this project, applied with \`railway config apply\` (pnpm clubedge
// deploy does it before each release). It replaces railway.json, which Railway stops reading on
// 2026-12-01. Railway builds the root Dockerfile; variables are set with \`railway variable set\`.
import { defineRailway, project, service } from "railway/iac";

// This repository manages only its own resources in the Railway project.
export const partial = ${name};

export default defineRailway(() => {
  const app = service(${name}, {
    // Migrations run before each release; a failed migration stops it.
    preDeploy: "node /app/migrate.mjs",
    healthcheck: "/api/health",
    healthcheckTimeout: 60,
  });

  return project(${name}, {
    variables: { managed: false },
    resources: [app],
  });
});
`;
}

/* ------------------------------------ Fly.io ------------------------------------ */

/** The public URL Fly gives an app. */
export const flyAppUrl = (app: string) => `https://${app}.fly.dev`;

/** A top-level `key = "value"` in fly.toml, which `fly launch` writes (app, primary_region). */
export function flyTomlValue(toml: string, key: string): string | null {
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) return null; // top-level keys come before the first table
    const match = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`).exec(line);
    if (match) return match[1]!;
  }
  return null;
}

/** The Redis URL in `fly redis create` or `fly redis status` output. */
export function parseRedisUrl(output: string): string | null {
  return /\b(rediss?:\/\/[^\s"'`]+)/.exec(output)?.[1] ?? null;
}

/** The secret names in `fly secrets list --json`: objects with Name (or name), or a plain list. */
export function flySecretNames(output: string): string[] {
  try {
    const value = JSON.parse(output) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => (typeof item === "string" ? item : (item?.Name ?? item?.name)))
      .filter((name): name is string => typeof name === "string");
  } catch {
    return [];
  }
}

/** `fly secrets import` input: NAME=VALUE lines. A value with a line break can't be imported this way. */
export function flySecretsInput(values: Record<string, string>): string {
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) throw new Error(`${key} has a line break, which Fly's secrets import can't take. Set it with fly secrets set.`);
  }
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}
