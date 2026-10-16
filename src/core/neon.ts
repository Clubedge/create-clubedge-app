// Neon (hosted PostgreSQL) for --infra neon: a free database created without an account through
// Neon's claimable Postgres API, kept for 72 hours unless the user claims it into a Neon account,
// and the pooled and direct URLs a project needs. src/neon.ts runs the `neon` command.
import { homedir } from "node:os";
import { join } from "node:path";

export const neonClaimableApi = "https://claimable.neon.tech/v1";
export const neonConsoleUrl = "https://console.neon.tech";
export const neonClaimableDocsUrl = "https://neon.com/docs/reference/claimable-postgres";

/** What the CLI keeps about a database it created, to show its expiry and claim it later. */
export interface NeonDatabase {
  projectId: string;
  /** The secret that proves the CLI created the project: it gets the tokens to claim it. */
  assertion: string;
  /** The pooled host, to recognise the database in an env file. */
  host: string;
  expiresAt: string;
  createdAt: string;
  /** The project directory it was created for, or a description such as "try on Railway". */
  project: string;
}

export interface CreatedDatabase {
  database: NeonDatabase;
  /** The pooled URL, for DATABASE_URL. */
  url: string;
  /** The direct URL, for DATABASE_URL_DIRECT. */
  directUrl: string;
}

export class NeonApiError extends Error {
  override name = "NeonApiError";
  constructor(
    message: string,
    /** Neon's error code, such as project_claimed or project_expired. */
    readonly code: string | null,
  ) {
    super(message);
  }
}

/* --------------------------------- URLs --------------------------------- */

function hostOf(url: string): string | null {
  try {
    return new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isNeonUrl(url: string): boolean {
  return hostOf(url)?.endsWith(".neon.tech") ?? false;
}

/** Neon's pooler is the compute's host with -pooler added: ep-name-123-pooler.region.aws.neon.tech. */
export function isNeonPooledUrl(url: string): boolean {
  const host = hostOf(url);
  return Boolean(host?.endsWith(".neon.tech") && /^[^.]+-pooler\./.test(host));
}

/** The compute a Neon URL connects to (its endpoint id), pooled or not; null for other URLs. */
export function neonEndpoint(url: string): string | null {
  const host = hostOf(url);
  if (!host?.endsWith(".neon.tech")) return null;
  return host.split(".")[0]!.replace(/-pooler$/, "");
}

/** The direct URL of a pooled Neon URL: the same URL without -pooler in the host. */
export function neonDirectUrl(url: string): string {
  if (!isNeonPooledUrl(url)) return url;
  const parsed = new URL(url.trim());
  parsed.hostname = parsed.hostname.replace(/^([^.]+)-pooler\./, "$1.");
  return parsed.toString();
}

/** The pooled URL of a direct Neon URL. */
export function neonPooledUrl(url: string): string {
  if (!isNeonUrl(url) || isNeonPooledUrl(url)) return url;
  const parsed = new URL(url.trim());
  parsed.hostname = parsed.hostname.replace(/^([^.]+)\./, "$1-pooler.");
  return parsed.toString();
}

/* ------------------------------ Claimable API ------------------------------ */

type Fetch = typeof fetch;

async function call<T>(fetcher: Fetch, path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(`${neonClaimableApi}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new NeonApiError(`Could not reach Neon (${error instanceof Error ? error.message : String(error)}).`, null);
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: reported below.
  }
  if (!response.ok) {
    const error = body as { error?: unknown; code?: unknown; message?: unknown; error_description?: unknown } | null;
    const code = [error?.code, error?.error].find((value): value is string => typeof value === "string") ?? null;
    const detail = [error?.message, error?.error_description].find((value): value is string => typeof value === "string");
    throw new NeonApiError(`Neon answered ${response.status}${code ? ` (${code})` : ""}${detail ? `: ${detail}` : "."}`, code);
  }
  return body as T;
}

/** Registers an anonymous identity, which creates the project. */
async function register(fetcher: Fetch, source: string) {
  const body = await call<{ identity_assertion?: unknown; project?: { id?: unknown; expires_at?: unknown } }>(fetcher, "/agent/identity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "anonymous", capabilities: ["postgres"], source }),
  });
  const assertion = body?.identity_assertion;
  const projectId = body?.project?.id;
  const expiresAt = body?.project?.expires_at;
  if (typeof assertion !== "string" || typeof projectId !== "string") {
    throw new NeonApiError("Neon created no project: its answer had no identity or project id.", null);
  }
  return { assertion, projectId, expiresAt: typeof expiresAt === "string" ? expiresAt : null };
}

/** A short-lived access token for the project, from the identity assertion. */
export async function neonAccessToken(assertion: string, fetcher: Fetch = fetch): Promise<string> {
  const body = await call<{ access_token?: unknown }>(fetcher, "/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
      resource: "https://claimable.neon.tech/",
    }).toString(),
  });
  if (typeof body?.access_token !== "string") throw new NeonApiError("Neon returned no access token.", null);
  return body.access_token;
}

/** The project's connection URL and expiry. Fails with project_claimed or project_expired. */
export async function neonCredentials(database: Pick<NeonDatabase, "projectId" | "assertion">, fetcher: Fetch = fetch) {
  const token = await neonAccessToken(database.assertion, fetcher);
  const body = await call<{ database_url?: unknown; expires_at?: unknown }>(fetcher, `/projects/${encodeURIComponent(database.projectId)}/credentials`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (typeof body?.database_url !== "string") throw new NeonApiError("Neon returned no connection URL.", null);
  return { url: body.database_url, expiresAt: typeof body.expires_at === "string" ? body.expires_at : null };
}

/**
 * Creates a free Neon database with no account: Neon keeps it for 72 hours (100 MB) unless it is
 * claimed. Returns its pooled and direct URLs, and what to keep to claim it later.
 */
export async function createClaimableDatabase(
  { project, source = "create-clubedge-app" }: { project: string; source?: string },
  fetcher: Fetch = fetch,
  now = new Date(),
): Promise<CreatedDatabase> {
  const identity = await register(fetcher, source);
  const credentials = await neonCredentials(identity, fetcher);
  const url = neonPooledUrl(credentials.url);
  const expiresAt = credentials.expiresAt ?? identity.expiresAt ?? new Date(now.getTime() + 72 * 3_600_000).toISOString();
  return {
    url,
    directUrl: neonDirectUrl(url),
    database: {
      projectId: identity.projectId,
      assertion: identity.assertion,
      host: hostOf(url) ?? "",
      expiresAt,
      createdAt: now.toISOString(),
      project,
    },
  };
}

/** A link that moves the project into the user's Neon account; it works for 15 minutes. */
export async function neonClaimUrl(database: Pick<NeonDatabase, "projectId" | "assertion">, fetcher: Fetch = fetch): Promise<string> {
  const token = await neonAccessToken(database.assertion, fetcher);
  const body = await call<{ verification_uri_complete?: unknown; verification_uri?: unknown }>(
    fetcher,
    `/projects/${encodeURIComponent(database.projectId)}/claim`,
    { method: "POST", headers: { authorization: `Bearer ${token}` } },
  );
  const url = [body?.verification_uri_complete, body?.verification_uri].find((value): value is string => typeof value === "string");
  if (!url) throw new NeonApiError("Neon returned no claim link.", null);
  return url;
}

export type NeonDatabaseState = { kind: "unclaimed"; hoursLeft: number } | { kind: "claimed" } | { kind: "expired" } | { kind: "unknown"; reason: string };

/** Where a database stands, asking Neon; network failures are "unknown", not errors. */
export async function neonDatabaseState(database: NeonDatabase, fetcher: Fetch = fetch, now = new Date()): Promise<NeonDatabaseState> {
  try {
    const credentials = await neonCredentials(database, fetcher);
    return { kind: "unclaimed", hoursLeft: hoursLeft(credentials.expiresAt ?? database.expiresAt, now) };
  } catch (error) {
    const code = error instanceof NeonApiError ? error.code : null;
    if (code === "project_claimed") return { kind: "claimed" };
    if (code === "project_expired") return { kind: "expired" };
    if (hoursLeft(database.expiresAt, now) <= 0) return { kind: "expired" };
    return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
}

export function hoursLeft(expiresAt: string, now = new Date()): number {
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 3_600_000));
}

/* ------------------------------ Saved databases ------------------------------ */

/** The databases the CLI created, next to its other files in the user's config folder. */
export function neonStatePath(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const configHome = env.XDG_CONFIG_HOME || (platform === "win32" && env.APPDATA ? env.APPDATA : join(homedir(), ".config"));
  return join(configHome, "clubedge", "neon.json");
}

/** Saved databases from the state file's text, newest first; unreadable entries are dropped. */
export function parseNeonState(text: string | null): NeonDatabase[] {
  if (!text) return [];
  try {
    const value = JSON.parse(text) as { databases?: unknown };
    const list = Array.isArray(value.databases) ? value.databases : [];
    return list
      .filter(
        (item): item is NeonDatabase =>
          typeof item?.projectId === "string" && typeof item.assertion === "string" && typeof item.expiresAt === "string" && typeof item.project === "string",
      )
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  } catch {
    return [];
  }
}

/** The state file with `database` added and databases past their claim window dropped. */
export function addNeonDatabase(text: string | null, database: NeonDatabase, now = new Date()): string {
  const kept = parseNeonState(text).filter((item) => item.projectId !== database.projectId && new Date(item.expiresAt).getTime() > now.getTime());
  return `${JSON.stringify({ databases: [database, ...kept] }, null, 2)}\n`;
}

/** The database an env file's DATABASE_URL points at, among the saved ones. */
export function savedDatabaseFor(databases: NeonDatabase[], url: string | undefined): NeonDatabase | null {
  const endpoint = url ? neonEndpoint(url) : null;
  if (!endpoint) return null;
  return databases.find((database) => neonEndpoint(`postgresql://${database.host}`) === endpoint) ?? null;
}

/* ------------------------------ Env files ------------------------------ */

/**
 * Sets variables in an env file's text: each KEY= line is replaced (the first one; a comment after
 * the value goes), and a missing variable is added at the end.
 */
export function setEnvValues(text: string, values: Record<string, string>): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const missing: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const at = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
    if (at === -1) missing.push(`${key}=${value}`);
    else lines[at] = `${key}=${value}`;
  }
  let result = lines.join(eol);
  if (missing.length) {
    if (result && !result.endsWith(eol)) result += eol;
    result += missing.join(eol) + eol;
  }
  return result;
}
