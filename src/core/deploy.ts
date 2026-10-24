// What `deploy` sets up on Railway for a project, as pure functions: the service name, the
// production variables, and reading the Railway CLI's output. src/deploy.ts runs the CLI.
import { isNeonPooledUrl, neonDirectUrl } from "./neon.js";
import type { ProjectService } from "./manifest.js";

/** The port the production image listens on (the Starter's Dockerfile sets PORT=3000). */
export const appPort = 3000;

/** Railway's names for the databases `railway add --database` creates, used in references. */
export const railwayDatabases = { postgres: "Postgres", redis: "Redis" } as const;

/** A Railway service name from the package name: lowercase letters, digits, and dashes. */
export function serviceName(packageName: string): string {
  const name = packageName.replace(/^@[^/]+\//, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return name || "web";
}

/**
 * Where the app finds a request's client address: CLIENT_IP_HEADER, a header the platform's edge
 * sets to it (overwriting any copy the client sent), or TRUSTED_PROXY_HOPS, the number of proxies
 * of your own that append to X-Forwarded-For (the app reads the entry that many places from the
 * right). Unset, the app is exposed directly and takes the socket's address. Both have safe
 * defaults, so deploy never reports them as unset.
 */
export const clientAddressKeys = ["CLIENT_IP_HEADER", "TRUSTED_PROXY_HOPS"];

/** What deploy sets on the public service of each platform. */
export const clientAddresses = {
  railway: { CLIENT_IP_HEADER: "x-real-ip" },
  render: { CLIENT_IP_HEADER: "true-client-ip" },
  fly: { CLIENT_IP_HEADER: "fly-client-ip" },
  vercel: { CLIENT_IP_HEADER: "x-real-ip" },
  netlify: { CLIENT_IP_HEADER: "x-nf-client-connection-ip" },
  // Docker Compose: Caddy, the one proxy in front, sets X-Forwarded-For to the client's address.
  docker: { TRUSTED_PROXY_HOPS: "1" },
} as const;

/**
 * An API reached only through its frontend's server, which replaces X-Forwarded-For with the one
 * client address it found: the API reads that entry, never a header a client could send.
 */
export const behindFrontend = { TRUSTED_PROXY_HOPS: "1" } as const;

/**
 * A public service's client-address settings: the env file's when it sets either one (they
 * describe one path to the client, so a default for the other would contradict it), else the
 * platform's.
 */
export function clientAddressVariables(platform: Readonly<Record<string, string>>, envFile: Record<string, string>): Record<string, string> {
  const own = clientAddressKeys.filter((key) => envFile[key]);
  return own.length ? Object.fromEntries(own.map((key) => [key, envFile[key]!])) : { ...platform };
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
 * has one), the public URL, the port, and where the client's address is. Values from --env-file
 * come next and win over those; their database URLs replace the platform's, except local ones (a
 * development env file). Everything else the example lists is reported as unset; values the
 * service already has count as set.
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
  /** Per-service listening port. */
  port?: number;
  /** Where the app finds the client's address on this platform (clientAddresses); the env file's settings replace it. */
  clientAddress?: Readonly<Record<string, string>>;
}): VariablePlan {
  const { modules, keys, url, envFile, secret, attached = [], port = appPort, clientAddress = {} } = input;
  const existing = { ...input.existing, ...Object.fromEntries(attached.map((key) => [key, "(attached)"])) };
  const external = externalDatabaseUrls(modules, envFile);
  const databases = input.databases ?? railwayReferences(databasesFor(modules, Object.keys(external)));
  const provided: Record<string, string> = { NODE_ENV: "production", PORT: String(port), ...databases };
  // The public URL under both names: TanStack Start reads APP_URL, Next.js NEXT_PUBLIC_APP_URL.
  const set: Record<string, string> = { ...provided, APP_URL: url, NEXT_PUBLIC_APP_URL: url, ...clientAddressVariables(clientAddress, envFile) };
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
  // A direct URL left from an earlier database would send migrations there: point it at the
  // database the app now uses, or blank it (blank counts as unset).
  else if (existing.DATABASE_URL_DIRECT) set.DATABASE_URL_DIRECT = set.DATABASE_URL ?? "";
  // Optional: without a direct URL, migrations and the jobs worker use DATABASE_URL, and the
  // client-address settings have safe defaults.
  const optional = ["DATABASE_URL_DIRECT", ...clientAddressKeys];
  const unset = keys.filter((key) => set[key] === undefined && !existing[key] && !optional.includes(key));
  return { set, unset };
}

/**
 * The variables of a frontend and an API deployed as two services. The API gets what planVariables
 * provides with the env file's server values, and the frontend's URL. The frontend gets its port,
 * where the client's address is, the env file's VITE_* build values, and the runtime values its
 * own example lists. With Better Auth the frontend's server runs auth: it gets the API's database,
 * the secret (generated unless the service already has one), and BETTER_AUTH_URL, the public URL
 * the API asks for the session. Each service's unset variables come from its own example.
 */
export function planServicePair(input: {
  modules: Record<string, string>;
  frontendKeys: string[];
  apiKeys: string[];
  url: string;
  existing: { frontend: Record<string, string>; api: Record<string, string> };
  envFile: Record<string, string>;
  secret: () => string;
  databases: Record<string, string>;
  ports: { frontend: number; api: number };
  /** Where the frontend, the public service, finds the client's address on this platform (clientAddresses). */
  clientAddress: Readonly<Record<string, string>>;
}): { frontend: VariablePlan; api: VariablePlan } {
  const { modules, frontendKeys, apiKeys, url, existing, envFile, secret, databases, ports } = input;
  const betterAuth = modules.auth === "better-auth";
  // A development env file's localhost URL would send sign-in links to this machine.
  const authUrl = envFile.BETTER_AUTH_URL && !isLocalUrl(envFile.BETTER_AUTH_URL) ? envFile.BETTER_AUTH_URL : url;

  // The env file's client-address settings are the public frontend's: the API is behind it.
  const apiEnv = Object.fromEntries(Object.entries(envFile).filter(([key]) => !key.startsWith("VITE_") && !clientAddressKeys.includes(key)));
  const api = planVariables({ modules, keys: apiKeys, url, existing: existing.api, envFile: apiEnv, secret, databases, port: ports.api, clientAddress: behindFrontend });
  // Better Auth's secret belongs to the frontend's server; the API only asks it for the session.
  if (!apiEnv.BETTER_AUTH_SECRET) delete api.set.BETTER_AUTH_SECRET;
  api.set.FRONTEND_URL = url;
  if (betterAuth) api.set.BETTER_AUTH_URL = authUrl;
  // The image listens on every interface: its Dockerfile sets HOST.
  api.unset = api.unset.filter((key) => api.set[key] === undefined && key !== "HOST");

  // railway.ts sets API_URL to the API's private address; the platform provides the database.
  const provided = ["API_URL", "PORT", "BETTER_AUTH_URL", ...Object.values(databaseVariables), "DATABASE_URL_DIRECT", ...clientAddressKeys];
  const set: Record<string, string> = { PORT: String(ports.frontend), ...clientAddressVariables(input.clientAddress, envFile) };
  for (const [key, value] of Object.entries(envFile)) {
    if (value && (key.startsWith("VITE_") || (frontendKeys.includes(key) && !provided.includes(key)))) set[key] = value;
  }
  if (betterAuth) {
    const database = api.set.DATABASE_URL ?? existing.api.DATABASE_URL;
    if (database) set.DATABASE_URL = database;
    set.BETTER_AUTH_URL = authUrl;
    if (!set.BETTER_AUTH_SECRET && !existing.frontend.BETTER_AUTH_SECRET) set.BETTER_AUTH_SECRET = secret();
  }
  // Optional: without VITE_API_URL the browser calls the API through the frontend's /api proxy,
  // and the client-address settings have safe defaults.
  const optional = ["API_URL", "VITE_API_URL", ...clientAddressKeys];
  const unset = frontendKeys.filter((key) => set[key] === undefined && !existing.frontend[key] && !optional.includes(key));
  return { frontend: { set, unset }, api };
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

/** `railway environment list --json`: an array of environments, or an object holding them. */
export function railwayEnvironmentNames(output: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("Railway listed its environments in a form deploy doesn't read. Check `railway environment list --json`.");
  }
  const list = Array.isArray(value) ? value : ((value as { environments?: unknown })?.environments ?? []);
  const items = Array.isArray(list) ? list : ((list as { edges?: unknown })?.edges ?? []);
  return (Array.isArray(items) ? items : [])
    .map((item) => (item as { node?: unknown })?.node ?? item)
    .map((item) => (item as { name?: unknown })?.name)
    .filter((name): name is string => typeof name === "string");
}

/** The body of `POST /v10/projects/:id/env?upsert=true`: encrypted Preview variables of one Git branch. */
export function vercelPreviewEnvBody(values: Record<string, string>, gitBranch: string) {
  return Object.entries(values).map(([key, value]) => ({ key, value, type: "encrypted", target: ["preview"], gitBranch }));
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
export function railwayIacSource(service: string, services?: Record<string, ProjectService>): string {
  if (services && Object.keys(services).length > 1) {
    const identifier = (slot: string) => slot.replace(/[^a-zA-Z0-9_$]/g, "_");
    const apiEntry = Object.entries(services).find(([, item]) => item.role === "api");
    const api = apiEntry?.[1];
    const apiIdentifier = apiEntry ? identifier(apiEntry[0]) : null;
    const ordered = Object.entries(services).sort(([, a], [, b]) => Number(a.role === "frontend") - Number(b.role === "frontend"));
    const resources = ordered.map(([slot, item]) => {
      const name = serviceName(`${service}-${item.id}`);
      const dockerfilePath = item.dockerfile;
      const healthcheck = item.healthPath;
      const migration = item.role === "api" ? 'preDeploy: "node /app/migrate.mjs",' : "";
      const env = item.role === "frontend" && api && apiIdentifier
        ? `env: { API_URL: \`http://\${${apiIdentifier}.env.RAILWAY_PRIVATE_DOMAIN}:${api.port}\` },`
        : "";
      return `  const ${identifier(slot)} = service(${JSON.stringify(name)}, {
    build: { builder: "DOCKERFILE", dockerfilePath: ${JSON.stringify(dockerfilePath)} },
    ${migration}
    ${env}
    healthcheck: ${JSON.stringify(healthcheck)},
    healthcheckTimeout: 60,
  });`;
    });
    const resourceNames = Object.keys(services).map(identifier).join(", ");
    return `// Generated from the selected stack packs; each app runs as its own Railway service.
import { defineRailway, project, service } from "railway/iac";

export const partial = ${JSON.stringify(service)};

export default defineRailway(() => {
${resources.join("\n\n")}
  return project(${JSON.stringify(service)}, {
    variables: { managed: false },
    resources: [${resourceNames}],
  });
});
`;
  }
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

/* ------------------------------------ Docker ------------------------------------ */
// A server of your own: Docker Compose runs each app's image behind Caddy, which serves the domain
// over HTTPS, and a GitHub workflow publishes the images to GitHub's container registry.

/** The app of a full-stack project, whose stack records no service: the root Dockerfile's image. */
export const fullstackService: ProjectService = {
  id: "web",
  role: "fullstack",
  app: "apps/web",
  dockerfile: "Dockerfile",
  port: appPort,
  healthPath: "/api/health",
  platforms: ["docker"],
};

/** The service the public reaches: a frontend, whose API stays private, else the full-stack app. */
export function publicService(services: Record<string, ProjectService>): ProjectService {
  const apps = Object.values(services);
  return apps.find(({ role }) => role === "frontend") ?? apps.find(({ role }) => role === "fullstack") ?? fullstackService;
}

/**
 * The values an app's image compiles in, which its Dockerfile takes as build arguments, from the
 * variables its env example lists: a Vite frontend's VITE_* values, and Next.js's public URL.
 */
export function buildArgumentKeys(service: ProjectService, keys: string[]): string[] {
  if (service.role === "frontend") return keys.filter((key) => key.startsWith("VITE_"));
  return service.role === "fullstack" ? keys.filter((key) => key === "NEXT_PUBLIC_APP_URL") : [];
}

/**
 * compose.yaml for a server of your own. Each app runs its image, pulled from IMAGE_PREFIX (where
 * release-images.yml publishes them) at TAG, or built there with --build. Only Caddy publishes
 * ports: it serves DOMAIN over HTTPS, with certificates it obtains and renews. `frontendKeys` are
 * the variables the public app's env example lists: the values its image compiles in become build
 * arguments, and a frontend's others runtime variables, such as Better Auth's when the frontend's
 * server runs auth. Compose reads their values from its --env-file; the public URL defaults to
 * https://DOMAIN.
 */
export function dockerComposeSource(project: string, services: Record<string, ProjectService>, frontendKeys: string[] = []): string {
  const apps = Object.values(services);
  const api = apps.find((service) => service.role === "api");
  const web = publicService(services);
  const fromEnv = (key: string, fallback = "") => `\${${key}:-${fallback}}`;
  const publicUrl = "https://${DOMAIN}";
  const behindCaddy: Record<string, string> = clientAddresses.docker;
  const behindWeb: Record<string, string> = behindFrontend;
  // API_URL is the API's address on the Compose network, PORT the one the image declares, and the
  // client-address settings default to Caddy's.
  const runtimeKeys = frontendKeys.filter((key) => !key.startsWith("VITE_") && !["API_URL", "PORT", ...clientAddressKeys].includes(key));
  // Better Auth runs in the frontend's server: the API asks it for the session over the Compose network.
  const authUrl = api && frontendKeys.includes("BETTER_AUTH_URL") ? `http://${web.id}:${web.port}` : null;

  const environment = (service: ProjectService): string[] => {
    if (service.role === "api") {
      return [
        // The API listens on every interface, whatever HOST the env file has from development.
        "      HOST: 0.0.0.0",
        `      # Reached only through ${web.id}, which passes on the client's address as the one X-Forwarded-For entry.`,
        ...clientAddressKeys.map((key) => `      ${key}: ${JSON.stringify(behindWeb[key] ?? "")}`),
        ...(authUrl ? [`      BETTER_AUTH_URL: ${authUrl}`] : []),
      ];
    }
    // A frontend has no env_file: CLIENT_IP_HEADER from the env file needs a line of its own.
    const address = [
      "      # Caddy, the one proxy in front, sets X-Forwarded-For to the client's address.",
      ...(service.role === "frontend" ? clientAddressKeys : Object.keys(behindCaddy)).map((key) => `      ${key}: ${fromEnv(key, behindCaddy[key])}`),
    ];
    if (service.role !== "frontend") return [...appUrlKeys.map((key) => `      ${key}: ${fromEnv(key, publicUrl)}`), ...address];
    return [
      ...(api ? [`      API_URL: http://${api.id}:${api.port}`] : []),
      ...address,
      ...runtimeKeys.map((key) => `      ${key}: ${fromEnv(key, key === "BETTER_AUTH_URL" ? publicUrl : "")}`),
    ];
  };

  const rows = apps.flatMap((service) => {
    const args = buildArgumentKeys(service, frontendKeys);
    return [
      `  ${service.id}:`,
      `    image: \${IMAGE_PREFIX:-${project}}-${service.id}:\${TAG:-latest}`,
      "    build:",
      "      context: .",
      `      dockerfile: ${service.dockerfile}`,
      ...(args.length ? ["      args:", ...args.map((key) => `        ${key}: ${fromEnv(key, key === "NEXT_PUBLIC_APP_URL" ? publicUrl : "")}`)] : []),
      // The frontend gets only the values it needs; the API's stay with the API.
      ...(service.role === "frontend" ? [] : ["    env_file:", "      - path: .env.production", "        required: false"]),
      "    environment:",
      ...environment(service),
      "    expose:",
      `      - "${service.port}"`,
      ...(service.role === "frontend" && api ? ["    depends_on:", `      - ${api.id}`] : []),
      "    restart: unless-stopped",
    ];
  });
  return [
    "# Generated by create-clubedge-app deploy. Caddy serves the app at DOMAIN over HTTPS, with",
    "# certificates it obtains and renews; the apps listen only on the Compose network. Each app's",
    "# image is pulled from IMAGE_PREFIX at TAG (release-images.yml publishes them), or built here",
    "# with --build. Run it with: docker compose --env-file .env.production up -d",
    "services:",
    ...rows,
    "  caddy:",
    "    image: caddy:2",
    "    restart: unless-stopped",
    "    ports:",
    '      - "80:80"',
    '      - "443:443"',
    '      - "443:443/udp"',
    "    environment:",
    '      DOMAIN: "${DOMAIN:?Set DOMAIN in .env.production to the domain that points at this server}"',
    "    volumes:",
    "      - ./Caddyfile:/etc/caddy/Caddyfile:ro",
    "      - caddy-data:/data",
    "      - caddy-config:/config",
    "    depends_on:",
    `      - ${web.id}`,
    "",
    "volumes:",
    "  caddy-data:",
    "  caddy-config:",
    "",
  ].join("\n");
}

/** The Caddyfile compose.yaml mounts: Caddy serves DOMAIN over HTTPS and passes every request to the public app. */
export function caddyfileSource(services: Record<string, ProjectService>): string {
  const web = publicService(services);
  return [
    "# Generated by create-clubedge-app deploy. Caddy serves DOMAIN, from .env.production, over HTTPS:",
    "# it obtains the certificate and renews it by itself once the domain's DNS points at this server.",
    "{$DOMAIN} {",
    `\treverse_proxy ${web.id}:${web.port}`,
    "}",
    "",
  ].join("\n");
}

export const releaseImagesPath = ".github/workflows/release-images.yml";

/**
 * The workflow that publishes the images compose.yaml pulls: each published GitHub release builds
 * every app's image for linux/amd64 and linux/arm64 and pushes it to the repository's GitHub
 * Container Registry, tagged with the version. Not on tag pushes: a deleted tag would leave its
 * images behind. The values an image compiles in come from the repository's variables.
 */
export function releaseImagesWorkflowSource(services: Record<string, ProjectService>, frontendKeys: string[] = []): string {
  const matrix = Object.values(services).flatMap((service) => {
    const args = buildArgumentKeys(service, frontendKeys);
    return [
      `          - service: ${service.id}`,
      `            dockerfile: ${service.dockerfile}`,
      "            context: .",
      ...(args.length
        ? ["            # The image compiles these in: set them as repository variables.", "            build-args: |", ...args.map((key) => `              ${key}=\${{ vars.${key} }}`)]
        : []),
    ];
  });
  return [
    "# Generated by create-clubedge-app deploy. Each published GitHub release builds every app's image",
    "# for linux/amd64 and linux/arm64 and pushes it to this repository's container registry as",
    "# ghcr.io/<owner>/<repository>-<service>, tagged with its version, <major>.<minor>, and latest;",
    "# compose.yaml runs them with IMAGE_PREFIX=ghcr.io/<owner>/<repository>. Run by hand on the",
    "# default branch, it pushes edge. New packages are private until you make them public.",
    "name: Release images",
    "",
    "on:",
    "  release:",
    "    types: [published]",
    "  workflow_dispatch:",
    "",
    "permissions:",
    "  contents: read",
    "  packages: write",
    "",
    "jobs:",
    "  image:",
    "    name: image (${{ matrix.service }})",
    "    runs-on: ubuntu-24.04",
    "    strategy:",
    "      matrix:",
    "        include:",
    ...matrix,
    "    steps:",
    "      - uses: actions/checkout@v7",
    "      # Builds the arm64 image on GitHub's amd64 runners.",
    "      - uses: docker/setup-qemu-action@v4",
    "      - uses: docker/setup-buildx-action@v4",
    "      - uses: docker/login-action@v4",
    "        with:",
    "          registry: ghcr.io",
    "          username: ${{ github.actor }}",
    "          password: ${{ secrets.GITHUB_TOKEN }}",
    "      - id: meta",
    "        uses: docker/metadata-action@v6",
    "        with:",
    "          # The action lowercases the name, as the registry requires.",
    "          images: ghcr.io/${{ github.repository }}-${{ matrix.service }}",
    "          flavor: latest=false",
    "          tags: |",
    "            type=semver,pattern={{version}}",
    "            type=semver,pattern={{major}}.{{minor}}",
    "            type=raw,value=latest,enable=${{ github.event_name == 'release' && !github.event.release.prerelease }}",
    "            type=edge",
    "            type=sha",
    "      - uses: docker/build-push-action@v7",
    "        with:",
    "          context: ${{ matrix.context }}",
    "          file: ${{ matrix.dockerfile }}",
    "          platforms: linux/amd64,linux/arm64",
    "          push: true",
    "          tags: ${{ steps.meta.outputs.tags }}",
    "          labels: ${{ steps.meta.outputs.labels }}",
    "          build-args: ${{ matrix.build-args }}",
    "          cache-from: type=gha,scope=${{ matrix.service }}",
    "          cache-to: type=gha,mode=max,scope=${{ matrix.service }}",
    "",
  ].join("\n");
}

/**
 * Where release-images.yml publishes a GitHub repository's images, as compose.yaml's IMAGE_PREFIX:
 * ghcr.io/<owner>/<repository> in lowercase, as the registry requires. Null for other Git hosts.
 */
export function ghcrImagePrefix(remote: string): string | null {
  const path = /^https:\/\/github\.com\/(.+)$/.exec(renderRepoUrl(remote) ?? "")?.[1];
  return path ? `ghcr.io/${path.toLowerCase()}` : null;
}
