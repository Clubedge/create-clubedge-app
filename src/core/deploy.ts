// What `deploy` sets up on Railway for a project, as pure functions: the service name, the
// production variables, and reading the Railway CLI's output. src/deploy.ts runs the CLI.
import { isNeonPooledUrl, neonDirectUrl } from "./neon.js";

/** The port the production image listens on (the Starter's Dockerfile sets PORT=3000). */
export const appPort = 3000;

/** Railway's names for the databases `railway add --database` creates, used in references. */
export const railwayDatabases = { postgres: "Postgres", redis: "Redis" } as const;

/** A Railway service name from the package name: lowercase letters, digits, and dashes. */
export function serviceName(packageName: string): string {
  const name = packageName.replace(/^@[^/]+\//, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return name || "web";
}

/** The variable each database's URL goes in. */
export const databaseVariables = { postgres: "DATABASE_URL", redis: "REDIS_URL" } as const;

/** A URL to this machine: from a development env file, unreachable from the deployed app. */
export function isLocalUrl(value: string): boolean {
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(value.trim())?.[1]?.toLowerCase() ?? "";
  return ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "host.docker.internal"].includes(host) || host.endsWith(".localhost");
}

/**
 * The database URLs an env file provides, for databases hosted elsewhere (Supabase, Neon, Upstash):
 * deploy uses them instead of creating the platform's own. Only the databases the project uses
 * count, and not empty or local URLs.
 */
export function externalDatabaseUrls(modules: Record<string, string>, envFile: Record<string, string>): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const database of databasesFor(modules)) {
    const key = databaseVariables[database];
    const value = envFile[key];
    if (value && !isLocalUrl(value)) urls[key] = value;
  }
  return urls;
}

/**
 * The databases a project needs from the platform: Postgres always (Drizzle), Redis with the redis
 * cache, except the ones whose URL comes from elsewhere (`external`: variable names).
 */
export function databasesFor(modules: Record<string, string>, external: Iterable<string> = []): Array<keyof typeof railwayDatabases> {
  const skip = new Set(external);
  const needed: Array<keyof typeof railwayDatabases> = modules.cache === "redis" ? ["postgres", "redis"] : ["postgres"];
  return needed.filter((database) => !skip.has(databaseVariables[database]));
}

/** References to Railway's databases, for the service's variables. */
export function railwayReferences(databases: Array<keyof typeof railwayDatabases>): Record<string, string> {
  return Object.fromEntries(databases.map((database) => [databaseVariables[database], `\${{${railwayDatabases[database]}.${databaseVariables[database]}}}`]));
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
 * The service's production variables. The CLI provides what it can: the database URLs (references
 * to Railway's databases by default), a generated Better Auth secret (unless the service already
 * has one), the public URL, and the port. Values from --env-file come next and win over those;
 * their database URLs replace the platform's, except local ones (a development env file).
 * Everything else the example lists is reported as unset; values the service already has count as set.
 */
export function planVariables(input: {
  modules: Record<string, string>;
  keys: string[];
  url: string;
  existing: Record<string, string>;
  envFile: Record<string, string>;
  secret: () => string;
  /** The database variables' values; by default references to the Railway databases the env file doesn't replace. */
  databases?: Record<string, string>;
  /** Variables the platform sets itself (Fly's `postgres attach` sets DATABASE_URL). */
  attached?: string[];
}): VariablePlan {
  const { modules, keys, url, envFile, secret, attached = [] } = input;
  const existing = { ...input.existing, ...Object.fromEntries(attached.map((key) => [key, "(attached)"])) };
  const external = externalDatabaseUrls(modules, envFile);
  const databases = input.databases ?? railwayReferences(databasesFor(modules, Object.keys(external)));
  const provided: Record<string, string> = { NODE_ENV: "production", PORT: String(appPort), ...databases };
  // The public URL under both names: TanStack Start reads APP_URL, Next.js NEXT_PUBLIC_APP_URL.
  const set: Record<string, string> = { ...provided, APP_URL: url, NEXT_PUBLIC_APP_URL: url };
  if (modules.auth === "better-auth" && !existing.BETTER_AUTH_SECRET) set.BETTER_AUTH_SECRET = secret();

  const databaseKeys: string[] = [...Object.values(databaseVariables), "DATABASE_URL_DIRECT"];
  for (const [key, value] of Object.entries(envFile)) {
    if (value === "" || databaseKeys.includes(key)) continue;
    // A development env file's localhost URL would send emailed links to this machine.
    if (appUrlKeys.includes(key) && isLocalUrl(value)) continue;
    set[key] = value;
  }
  Object.assign(set, external);
  const direct = directDatabaseUrl(external.DATABASE_URL, envFile.DATABASE_URL_DIRECT);
  if (direct) set.DATABASE_URL_DIRECT = direct;
  // Optional: without it, migrations and the jobs worker use DATABASE_URL.
  const unset = keys.filter((key) => set[key] === undefined && !existing[key] && key !== "DATABASE_URL_DIRECT");
  return { set, unset };
}

/**
 * DATABASE_URL_DIRECT for a database hosted elsewhere: the env file's, or for a pooled Neon URL the
 * same URL without -pooler. Never next to the platform's own database (no external URL), where it
 * would send migrations to another database.
 */
export function directDatabaseUrl(external: string | undefined, direct: string | undefined): string | null {
  if (!external) return null;
  if (direct?.trim() && !isLocalUrl(direct)) return direct.trim();
  return isNeonPooledUrl(external) ? neonDirectUrl(external) : null;
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

export function meetsMinimumCli(version: readonly number[], minimum: readonly number[] = minimumRailwayCli): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i]! !== minimum[i]) return version[i]! > minimum[i]!;
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

// Vercel: the platform only runs the app. Databases, Redis, storage, and email come from the env file.

/** vercel@50.5.1 added `vercel api`, which deploy uses to create the project and set its variables. */
export const minimumVercelCli = [50, 5, 1] as const;

/** Where Vercel builds: the app's folder, with the whole workspace uploaded. */
export const vercelRootDirectory = "apps/web";

/** The variables that hold the public URL: readable on Vercel ("plain"), so a later deploy can compare them. */
export const appUrlKeys = ["APP_URL", "NEXT_PUBLIC_APP_URL"];

export interface VercelProject {
  id: string;
  name: string;
  rootDirectory: string | null;
}

/** A project in `vercel api /v9/projects/:name` output, or null. */
export function parseVercelProject(output: string): VercelProject | null {
  try {
    const value = JSON.parse(output) as { id?: unknown; name?: unknown; rootDirectory?: unknown };
    if (typeof value.id !== "string" || typeof value.name !== "string") return null;
    return { id: value.id, name: value.name, rootDirectory: typeof value.rootDirectory === "string" ? value.rootDirectory : null };
  } catch {
    return null;
  }
}

/** The project's production variables from `vercel api /v10/projects/:id/env`: plain values as they are, the rest as "(set)". */
export function parseVercelEnv(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  try {
    const { envs } = JSON.parse(output) as { envs?: Array<{ key?: unknown; value?: unknown; type?: unknown; target?: unknown }> };
    for (const env of envs ?? []) {
      const targets = Array.isArray(env.target) ? env.target : [env.target];
      if (typeof env.key !== "string" || !targets.includes("production")) continue;
      values[env.key] = env.type === "plain" && typeof env.value === "string" ? env.value : "(set)";
    }
  } catch {
    // Unknown output: every variable counts as unset, and the upsert sets them again.
  }
  return values;
}

/** The body of `POST /v10/projects/:id/env?upsert=true`: production variables, encrypted except the public URL. */
export function vercelEnvBody(values: Record<string, string>): Array<{ key: string; value: string; type: string; target: string[] }> {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value,
    type: appUrlKeys.includes(key) ? "plain" : "encrypted",
    target: ["production"],
  }));
}

/**
 * The public URL Vercel gave a production deployment, from `vercel api /v13/deployments/:url`: the
 * shortest *.vercel.app alias that isn't the deployment's own URL or a Git branch's.
 */
export function vercelProductionUrl(output: string, deploymentUrl: string): string | null {
  const own = deploymentUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  try {
    const { alias } = JSON.parse(output) as { alias?: unknown };
    const names = (Array.isArray(alias) ? alias : [])
      .filter((name): name is string => typeof name === "string")
      .map((name) => name.toLowerCase())
      .filter((name) => name.endsWith(".vercel.app") && name !== own && !name.includes("-git-"))
      .sort((a, b) => a.length - b.length);
    return names[0] ? `https://${names[0]}` : null;
  } catch {
    return null;
  }
}

/** The deployment URL `vercel deploy` prints on stdout (its last https URL). */
export function parseVercelDeploymentUrl(output: string): string | null {
  const urls = output.match(/https:\/\/[a-z0-9.-]+\.vercel\.app\b/gi);
  return urls?.at(-1)?.toLowerCase() ?? null;
}

/**
 * .vercelignore for a project without one: the CLI uploads everything but a short list, which
 * keeps .env.local out but not .env or .env.production. Uploading what Git would commit keeps
 * secrets and build output out, as `try` does.
 */
export function vercelIgnoreSource(gitignore: string): string {
  const lines = gitignore.split(/\r?\n/).map((line) => line.trimEnd());
  const required = [".env*", "!.env.example"].filter((line) => !lines.includes(line));
  return [
    "# What `vercel deploy` leaves out: what Git ignores, so secrets in .env files and build output",
    "# stay on this machine. Vercel reads its variables from the project's settings.",
    ...lines.filter((line, index) => line || index < lines.length - 1),
    ...required,
    "",
  ].join("\n");
}

/** Whether a .vercelignore keeps .env files out of the upload. */
export function ignoresEnvFiles(vercelignore: string): boolean {
  return vercelignore.split(/\r?\n/).some((line) => /^\/?(\*\*\/)?\.env(\*|\.\*)?\/?$/.test(line.trim()));
}

/* ------------------------------------ Netlify ------------------------------------ */
// Netlify only runs the app, as Vercel does: databases, Redis, storage, and email come from the env file.

/** Where Netlify builds: the app's folder, which holds netlify.toml. */
export const netlifyBaseDirectory = "apps/web";

/** A Netlify site name: lowercase letters, digits, and dashes, at most 63 characters. */
export function netlifySiteName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/, "") || "web";
}

export interface NetlifySite {
  id: string;
  name: string;
  /** The site's https URL, such as https://my-app.netlify.app. */
  url: string;
  base: string | null;
}

/** A site in `netlify api getSite` or `createSiteInTeam` output, or null. */
export function parseNetlifySite(output: string): NetlifySite | null {
  try {
    const value = JSON.parse(output) as { id?: unknown; name?: unknown; ssl_url?: unknown; url?: unknown; build_settings?: { base?: unknown } };
    if (typeof value.id !== "string" || typeof value.name !== "string") return null;
    const url = typeof value.ssl_url === "string" && value.ssl_url ? value.ssl_url : `https://${value.name}.netlify.app`;
    const base = typeof value.build_settings?.base === "string" ? value.build_settings.base : null;
    return { id: value.id, name: value.name, url: url.replace(/\/+$/, ""), base };
  } catch {
    return null;
  }
}

/** The team slugs in `netlify api listAccountsForUser` output. */
export function parseNetlifyAccounts(output: string): string[] {
  try {
    const value = JSON.parse(output) as unknown;
    if (!Array.isArray(value)) return [];
    return value.map((account) => account?.slug).filter((slug): slug is string => typeof slug === "string");
  } catch {
    return [];
  }
}

/**
 * The file `netlify env:import` reads: KEY='value' lines. Each value is quoted with a quote it
 * doesn't contain, so dotenv keeps it as it is (#, spaces, $); a line break can't be imported.
 */
export function netlifyEnvFile(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => {
      if (/[\r\n]/.test(value)) throw new Error(`${key} has a line break, which Netlify's env:import can't take. Set it in the site's settings.`);
      const quote = ["'", '"', "`"].find((mark) => !value.includes(mark));
      if (!quote) throw new Error(`${key} contains every kind of quote, which Netlify's env:import can't take. Set it in the site's settings.`);
      return `${key}=${quote}${value}${quote}`;
    })
    .join("\n")
    .concat("\n");
}

/** The production URL in `netlify deploy --json` output (the last JSON object it prints). */
export function parseNetlifyDeploy(output: string): string | null {
  for (let index = output.lastIndexOf("{"); index >= 0; index = output.lastIndexOf("{", index - 1)) {
    try {
      const value = JSON.parse(output.slice(index)) as { url?: unknown; deploy_url?: unknown };
      const url = typeof value.url === "string" ? value.url : typeof value.deploy_url === "string" ? value.deploy_url : null;
      if (url) return url.replace(/\/+$/, "");
    } catch {
      // Not the start of the JSON object: try the one before.
    }
  }
  return null;
}

/* ------------------------------------ Render ------------------------------------ */
// Render builds the Dockerfile from the project's Git repository, through Render's API.

export const renderApiUrl = "https://api.render.com/v1";

/** Deploy statuses Render does not move on from. */
export const renderFinalStatuses = ["live", "deactivated", "build_failed", "update_failed", "canceled", "pre_deploy_failed"] as const;

/**
 * The https URL of a Git remote Render can build from (GitHub, GitLab, or Bitbucket), from an
 * https or SSH remote; null for anything else.
 */
export function renderRepoUrl(remote: string): string | null {
  const value = remote.trim();
  const match =
    /^(?:git@|ssh:\/\/git@)(github\.com|gitlab\.com|bitbucket\.org)[:/](.+?)(?:\.git)?\/?$/i.exec(value) ??
    /^https:\/\/(?:[^@/]+@)?(github\.com|gitlab\.com|bitbucket\.org)\/(.+?)(?:\.git)?\/?$/i.exec(value);
  return match ? `https://${match[1]!.toLowerCase()}/${match[2]}` : null;
}

/**
 * The body of `POST /v1/services`: a Docker web service on a paid instance type, since pre-deploy
 * commands (the migrations before each release) need one, as in render.yaml.
 */
export function renderServiceBody(input: {
  name: string;
  ownerId: string;
  repo: string;
  branch: string;
  values: Record<string, string>;
}): Record<string, unknown> {
  return {
    type: "web_service",
    name: input.name,
    ownerId: input.ownerId,
    repo: input.repo,
    branch: input.branch,
    autoDeploy: "yes",
    serviceDetails: {
      runtime: "docker",
      plan: "starter",
      healthCheckPath: "/api/health",
      preDeployCommand: "node /app/migrate.mjs",
      envSpecificDetails: { dockerfilePath: "./Dockerfile", dockerContext: "." },
    },
    envVars: Object.entries(input.values).map(([key, value]) => ({ key, value })),
  };
}

export interface RenderService {
  id: string;
  name: string;
  url: string | null;
}

/** A service from Render's API: `{ service }` items in a list, or the service itself. */
function renderService(value: unknown): RenderService | null {
  const item = (value as { service?: unknown })?.service ?? value;
  const service = item as { id?: unknown; name?: unknown; serviceDetails?: { url?: unknown } };
  if (typeof service?.id !== "string" || typeof service.name !== "string") return null;
  const url = service.serviceDetails?.url;
  return { id: service.id, name: service.name, url: typeof url === "string" && url ? url.replace(/\/+$/, "") : null };
}

/** The service named `name` in `GET /v1/services?name=...`, or the one `POST /v1/services` created. */
export function parseRenderService(body: unknown, name?: string): RenderService | null {
  if (Array.isArray(body)) {
    return body.map(renderService).find((service) => service && (!name || service.name === name)) ?? null;
  }
  return renderService(body);
}

/** The workspaces in `GET /v1/owners`: `{ owner: { id, name } }` items. */
export function parseRenderOwners(body: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(body)) return [];
  return body
    .map((item) => (item as { owner?: { id?: unknown; name?: unknown } })?.owner)
    .filter((owner): owner is { id: string; name: string } => typeof owner?.id === "string" && typeof owner.name === "string");
}

/** The variable names and values in `GET /v1/services/:id/env-vars`: `{ envVar: { key, value } }` items. */
export function parseRenderEnv(body: unknown): Record<string, string> {
  if (!Array.isArray(body)) return {};
  const values: Record<string, string> = {};
  for (const item of body) {
    const env = (item as { envVar?: { key?: unknown; value?: unknown } })?.envVar ?? item;
    if (typeof env?.key === "string") values[env.key] = typeof env.value === "string" ? env.value : "(set)";
  }
  return values;
}
