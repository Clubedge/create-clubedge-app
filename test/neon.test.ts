import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/args.js";
import { directDatabaseUrl, planVariables } from "../src/core/deploy.js";
import { checkDatabaseUrls } from "../src/core/health.js";
import {
  addNeonDatabase,
  createClaimableDatabase,
  ensureNeonBranch,
  isNeonPooledUrl,
  isNeonUrl,
  neonClaimUrl,
  neonDatabaseState,
  neonDirectUrl,
  neonEndpoint,
  neonRoleAndDatabase,
  neonPooledUrl,
  neonStatePath,
  parseNeonState,
  previewBranchName,
  savedDatabaseFor,
  setEnvValues,
  type NeonDatabase,
} from "../src/core/neon.js";
import { projectTryProblem, tryModules, tryScript } from "../src/core/railway.js";
import { previewName } from "../src/deploy-preview.js";

const pooled = "postgresql://neondb_owner:p%40ss@ep-cool-name-a1b2c3-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const direct = "postgresql://neondb_owner:p%40ss@ep-cool-name-a1b2c3.eu-central-1.aws.neon.tech/neondb?sslmode=require";

describe("Neon URLs", () => {
  it("tells pooled from direct and converts between them", () => {
    expect(isNeonUrl(pooled)).toBe(true);
    expect(isNeonPooledUrl(pooled)).toBe(true);
    expect(isNeonPooledUrl(direct)).toBe(false);
    expect(neonDirectUrl(pooled)).toBe(direct);
    expect(neonPooledUrl(direct)).toBe(pooled);
    expect(neonDirectUrl(direct)).toBe(direct);
    expect(neonPooledUrl(pooled)).toBe(pooled);
    expect(neonEndpoint(pooled)).toBe("ep-cool-name-a1b2c3");
    expect(neonEndpoint(direct)).toBe("ep-cool-name-a1b2c3");
  });

  it("leaves other URLs alone", () => {
    const supabase = "postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres";
    expect(isNeonUrl(supabase)).toBe(false);
    expect(neonPooledUrl(supabase)).toBe(supabase);
    expect(neonEndpoint(supabase)).toBeNull();
    expect(isNeonUrl("not a url")).toBe(false);
  });
});

/** A fake of Neon's claimable API: each path answers with the next queued response. */
function fakeNeon(routes: Record<string, Array<{ status?: number; body: unknown }>>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const path = Object.keys(routes).find((key) => url.endsWith(key));
    const answer = path ? routes[path]!.shift() : undefined;
    if (!answer) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, calls };
}

const token = { body: { access_token: "tok", token_type: "Bearer", expires_in: 900 } };

describe("Neon's claimable API", () => {
  it("creates a database with pooled and direct URLs", async () => {
    const { fetcher, calls } = fakeNeon({
      "/agent/identity": [{ body: { identity_assertion: "secret", project: { id: "proj-1", expires_at: "2026-10-19T00:00:00Z" } } }],
      "/oauth2/token": [token],
      // Neon may return the direct URL; the app gets the pooled one either way.
      "/projects/proj-1/credentials": [{ body: { database_url: direct, expires_at: "2026-10-19T01:00:00Z" } }],
    });
    const created = await createClaimableDatabase({ project: "/work/my-app" }, fetcher, new Date("2026-10-16T00:00:00Z"));
    expect(created.url).toBe(pooled);
    expect(created.directUrl).toBe(direct);
    expect(created.database).toEqual({
      projectId: "proj-1",
      assertion: "secret",
      host: "ep-cool-name-a1b2c3-pooler.eu-central-1.aws.neon.tech",
      expiresAt: "2026-10-19T01:00:00Z",
      createdAt: "2026-10-16T00:00:00.000Z",
      project: "/work/my-app",
    });
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ type: "anonymous", capabilities: ["postgres"], source: "create-clubedge-app" });
    expect(String(calls[1]!.init!.body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    expect((calls[2]!.init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("gets a claim link", async () => {
    const { fetcher } = fakeNeon({
      "/oauth2/token": [token],
      "/projects/proj-1/claim": [{ body: { verification_uri: "https://neon.com/claim", verification_uri_complete: "https://neon.com/claim?code=ABC" } }],
    });
    expect(await neonClaimUrl({ projectId: "proj-1", assertion: "secret" }, fetcher)).toBe("https://neon.com/claim?code=ABC");
  });

  const saved: NeonDatabase = {
    projectId: "proj-1",
    assertion: "secret",
    host: "ep-cool-name-a1b2c3-pooler.eu-central-1.aws.neon.tech",
    expiresAt: "2026-10-19T00:00:00Z",
    createdAt: "2026-10-16T00:00:00Z",
    project: "/work/my-app",
  };
  const now = new Date("2026-10-18T00:00:00Z");

  it("reports unclaimed, claimed, expired, and unreachable databases", async () => {
    const unclaimed = fakeNeon({ "/oauth2/token": [token], "/projects/proj-1/credentials": [{ body: { database_url: pooled, expires_at: saved.expiresAt } }] });
    expect(await neonDatabaseState(saved, unclaimed.fetcher, now)).toEqual({ kind: "unclaimed", hoursLeft: 24 });

    const claimed = fakeNeon({ "/oauth2/token": [{ status: 403, body: { error: "project_claimed", message: "Claimed." } }] });
    expect(await neonDatabaseState(saved, claimed.fetcher, now)).toEqual({ kind: "claimed" });

    const expired = fakeNeon({ "/oauth2/token": [token], "/projects/proj-1/credentials": [{ status: 410, body: { code: "project_expired" } }] });
    expect(await neonDatabaseState(saved, expired.fetcher, now)).toEqual({ kind: "expired" });

    const offline = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch;
    expect(await neonDatabaseState(saved, offline, now)).toMatchObject({ kind: "unknown" });
    expect(await neonDatabaseState(saved, offline, new Date("2026-10-20T00:00:00Z"))).toEqual({ kind: "expired" });
  });

  it("keeps saved databases newest first, dropping expired ones", () => {
    const older = { ...saved, projectId: "proj-0", createdAt: "2026-10-15T00:00:00Z", host: "ep-old-pooler.eu.aws.neon.tech" };
    const gone = { ...saved, projectId: "proj-gone", expiresAt: "2026-10-17T00:00:00Z" };
    let text = addNeonDatabase(null, gone, new Date("2026-10-16T00:00:00Z"));
    text = addNeonDatabase(text, older, now);
    text = addNeonDatabase(text, saved, now);
    expect(parseNeonState(text).map((item) => item.projectId)).toEqual(["proj-1", "proj-0"]);
    expect(parseNeonState("not json")).toEqual([]);
    expect(savedDatabaseFor(parseNeonState(text), direct)?.projectId).toBe("proj-1");
    expect(savedDatabaseFor(parseNeonState(text), "postgresql://u:p@localhost/app")).toBeNull();
  });

  it("keeps the state next to the CLI's other files", () => {
    expect(neonStatePath({ XDG_CONFIG_HOME: "/cfg" }, "linux")).toBe(join("/cfg", "clubedge", "neon.json"));
  });
});

describe("setEnvValues", () => {
  it("replaces the variables' lines and adds missing ones", () => {
    const text = "# Neon\nDATABASE_URL=\nDATABASE_URL_DIRECT=old # note\nREDIS_URL=\n";
    expect(setEnvValues(text, { DATABASE_URL: pooled, DATABASE_URL_DIRECT: direct, NEW: "x" })).toBe(
      `# Neon\nDATABASE_URL=${pooled}\nDATABASE_URL_DIRECT=${direct}\nREDIS_URL=\nNEW=x\n`,
    );
  });

  it("keeps Windows line endings and adds a final newline", () => {
    expect(setEnvValues("A=1\r\nB=2", { B: "3", C: "4" })).toBe("A=1\r\nB=3\r\nC=4\r\n");
  });
});

describe("doctor's database check", () => {
  const input = { infra: "neon", claimable: null, cli: "pnpm clubedge", envPath: "apps/web/.env.local" };
  const check = (env: Record<string, string>, extra: Partial<Parameters<typeof checkDatabaseUrls>[0]> = {}) =>
    checkDatabaseUrls({ ...input, env, ...extra });

  it("passes pooled and direct URLs of one Neon database", () => {
    expect(check({ DATABASE_URL: pooled, DATABASE_URL_DIRECT: direct })?.status).toBe("ok");
  });

  it("fails an empty URL with infra neon, and a direct URL on the pooler", () => {
    expect(check({})).toMatchObject({ status: "fail", fix: expect.stringContaining("neon create") });
    expect(check({}, { infra: "docker" })).toBeNull();
    expect(check({ DATABASE_URL: pooled, DATABASE_URL_DIRECT: pooled })).toMatchObject({ status: "fail", detail: expect.stringContaining("pooler") });
  });

  it("warns about a direct app URL, a missing direct URL, and two different databases", () => {
    expect(check({ DATABASE_URL: direct })).toMatchObject({ status: "warn", detail: expect.stringContaining("direct host") });
    expect(check({ DATABASE_URL: pooled })).toMatchObject({ status: "warn", detail: expect.stringContaining("not set") });
    const other = direct.replace("ep-cool-name-a1b2c3", "ep-other-d4e5f6");
    expect(check({ DATABASE_URL: pooled, DATABASE_URL_DIRECT: other })).toMatchObject({ status: "warn", detail: expect.stringContaining("different") });
  });

  it("reports how long a free database has left", () => {
    const env = { DATABASE_URL: pooled, DATABASE_URL_DIRECT: direct };
    expect(check(env, { claimable: { kind: "unclaimed", hoursLeft: 50 } })).toMatchObject({ status: "ok", detail: expect.stringContaining("50 hours") });
    expect(check(env, { claimable: { kind: "unclaimed", hoursLeft: 5 } })).toMatchObject({ status: "warn", fix: expect.stringContaining("neon claim") });
    expect(check(env, { claimable: { kind: "expired" } })).toMatchObject({ status: "fail" });
    expect(check(env, { claimable: { kind: "claimed" } })?.status).toBe("ok");
  });

  it("says nothing for other databases without a direct URL", () => {
    expect(check({ DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/app" }, { infra: "docker" })).toBeNull();
    expect(check({ DATABASE_URL: "postgresql://u:p@db.example.com/app", DATABASE_URL_DIRECT: "postgresql://u:p@db.example.com:5433/app" }, { infra: "none" })?.status).toBe("ok");
  });
});

describe("deploy's direct database URL", () => {
  const base = {
    modules: { auth: "none", cache: "memory" },
    keys: ["DATABASE_URL", "DATABASE_URL_DIRECT"],
    url: "https://my-app.vercel.app",
    existing: {},
    secret: () => "s3cret",
    databases: {},
  };

  it("derives it from a pooled Neon URL, or takes the env file's", () => {
    expect(planVariables({ ...base, envFile: { DATABASE_URL: pooled } }).set).toMatchObject({ DATABASE_URL: pooled, DATABASE_URL_DIRECT: direct });
    const own = "postgresql://u:p@db.example.com:5432/app";
    expect(planVariables({ ...base, envFile: { DATABASE_URL: pooled, DATABASE_URL_DIRECT: own } }).set.DATABASE_URL_DIRECT).toBe(own);
  });

  it("never sends one next to the platform's own database, and doesn't list it as unset", () => {
    const plan = planVariables({ ...base, databases: undefined, envFile: { DATABASE_URL_DIRECT: direct } });
    expect(plan.set.DATABASE_URL).toBe("${{Postgres.DATABASE_URL}}");
    expect(plan.set.DATABASE_URL_DIRECT).toBeUndefined();
    expect(plan.unset).toEqual([]);
  });

  it("skips a local or missing direct URL", () => {
    expect(directDatabaseUrl(undefined, direct)).toBeNull();
    expect(directDatabaseUrl("postgresql://u:p@db.example.com/app", "postgresql://u:p@localhost/app")).toBeNull();
    expect(directDatabaseUrl("postgresql://u:p@db.example.com/app", undefined)).toBeNull();
  });
});

describe("neon on the command line", () => {
  it("parses the neon command and --no-neon", () => {
    expect(parseCliArgs(["neon"]).command).toEqual({ name: "neon", action: "status" });
    expect(parseCliArgs(["neon", "claim", "--no-open"]).command).toEqual({ name: "neon", action: "claim" });
    expect(parseCliArgs(["neon", "create", "--yes"]).command).toEqual({ name: "neon", action: "create" });
    expect(() => parseCliArgs(["neon", "delete"])).toThrow(/Usage: neon/);
    expect(parseCliArgs(["my-app", "--infra", "neon", "--no-neon"])).toMatchObject({ neon: false, modules: { infra: "neon" } });
    expect(parseCliArgs(["my-app"]).neon).toBe(true);
  });

  it("lets try use a Neon database", () => {
    expect(tryModules({ infra: "neon" })).toEqual({ infra: "neon", auth: "better-auth", email: "none" });
    expect(projectTryProblem({ infra: "neon", auth: "better-auth" })).toBeNull();
  });

  it("writes the database URLs into the VM's env files, whatever their characters", () => {
    const tricky = { url: "postgresql://u:p&a|b/c'd$e@ep-x-pooler.eu.aws.neon.tech/neondb?sslmode=require", directUrl: direct };
    const script = tryScript({
      source: { kind: "create", cliVersion: "0.30.0" },
      modules: tryModules({ infra: "neon" }),
      previewUrl: "https://x.up.railway.app",
      database: tricky,
    });
    expect(script).toContain('step "Using the Neon database"');
    expect(script).toContain("db:migrate");
    expect(script).not.toContain("Starting the local database");

    // Run the script's node command on a copy of an env file.
    const line = script
      .split("\n")
      .find((entry) => entry.startsWith("node -e "))!
      .split(' >>"$log"')[0]!;
    const dir = mkdtempSync(join(tmpdir(), "clubedge-neon-"));
    try {
      mkdirSync(join(dir, "apps", "web"), { recursive: true });
      writeFileSync(join(dir, "apps", "web", ".env.local"), "DATABASE_URL=\nREDIS_URL=\n");
      const shell = process.platform === "win32" ? "bash" : "sh";
      const result = spawnSync(shell, ["-c", line.replace(" apps/*/.env.local", " apps/web/.env.local")], { cwd: dir, encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(readFileSync(join(dir, "apps", "web", ".env.local"), "utf8")).toBe(`DATABASE_URL=${tricky.url}\nREDIS_URL=\nDATABASE_URL_DIRECT=${direct}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("preview branches", () => {
  it("names branches and Railway environments after the Git branch", () => {
    expect(previewBranchName("feature/Sign-up_flow")).toBe("preview/feature-sign-up-flow");
    expect(previewBranchName("///")).toBe("preview/branch");
    expect(previewBranchName("x".repeat(80))).toBe(`preview/${"x".repeat(40)}`);
    expect(previewName("feature/Sign-up_flow")).toBe("preview-feature-sign-up-flow");
  });

  it("connects as production's role and database, or Neon's defaults", () => {
    expect(neonRoleAndDatabase(pooled)).toEqual({ role: "neondb_owner", database: "neondb" });
    expect(neonRoleAndDatabase("postgresql://app_user:x@ep-a-1-pooler.eu.aws.neon.tech/shop")).toEqual({ role: "app_user", database: "shop" });
    expect(neonRoleAndDatabase("postgresql://u:p@db.example.com/app")).toEqual({ role: "neondb_owner", database: "neondb" });
    expect(neonRoleAndDatabase(undefined)).toEqual({ role: "neondb_owner", database: "neondb" });
  });

  const input = { apiKey: "key", projectId: "proj-1", name: "preview/feature", role: "neondb_owner", database: "neondb" };

  it("creates a missing branch with a compute and returns its URLs", async () => {
    const { fetcher, calls } = fakeNeon({
      "/branches?search=preview%2Ffeature": [{ body: { branches: [{ id: "br-main", name: "main" }] } }],
      "/projects/proj-1/branches": [
        {
          status: 201,
          body: {
            branch: { id: "br-new", name: "preview/feature" },
            connection_uris: [{ connection_uri: direct, connection_parameters: { role: "neondb_owner", database: "neondb" } }],
          },
        },
      ],
    });
    expect(await ensureNeonBranch(input, fetcher)).toEqual({ id: "br-new", name: "preview/feature", created: true, url: pooled, directUrl: direct });
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ branch: { name: "preview/feature" }, endpoints: [{ type: "read_write" }] });
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer key");
  });

  it("reuses a branch from an earlier preview", async () => {
    const { fetcher, calls } = fakeNeon({
      "/branches?search=preview%2Ffeature": [{ body: { branches: [{ id: "br-1", name: "preview/feature" }] } }],
      "/connection_uri?branch_id=br-1&database_name=neondb&role_name=neondb_owner": [{ body: { uri: direct } }],
    });
    expect(await ensureNeonBranch(input, fetcher)).toMatchObject({ id: "br-1", created: false, url: pooled, directUrl: direct });
    expect(calls).toHaveLength(2);
  });

  it("names the setting to check when Neon refuses", async () => {
    const { fetcher } = fakeNeon({ "/branches?search=preview%2Ffeature": [{ status: 401, body: { message: "authentication required" } }] });
    await expect(ensureNeonBranch(input, fetcher)).rejects.toThrow(/NEON_API_KEY/);
  });

  it("parses --preview for deploy only", () => {
    expect(parseCliArgs(["deploy", "--preview"]).preview).toBe(true);
    expect(() => parseCliArgs(["my-app", "--preview"])).toThrow(/only apply to deploy/);
  });
});
