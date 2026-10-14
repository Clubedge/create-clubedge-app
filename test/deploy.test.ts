import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/args.js";
import {
  databasesFor,
  externalDatabaseUrls,
  isLocalUrl,
  deploymentStatus,
  meetsMinimumCli,
  exampleKeys,
  flyAppUrl,
  flySecretNames,
  flySecretsInput,
  flyTomlValue,
  parseDeploymentId,
  parseEnvFile,
  parseRedisUrl,
  parseRailwayDomain,
  parseVariables,
  planVariables,
  railwayCliVersion,
  railwayIacSource,
  serviceName,
  serviceNames,
  ignoresEnvFiles,
  minimumVercelCli,
  parseVercelDeploymentUrl,
  parseVercelEnv,
  parseVercelProject,
  vercelEnvBody,
  netlifyEnvFile,
  netlifySiteName,
  parseNetlifyAccounts,
  parseNetlifyDeploy,
  parseNetlifySite,
  parseRenderEnv,
  parseRenderOwners,
  parseRenderService,
  renderRepoUrl,
  renderServiceBody,
  vercelIgnoreSource,
  vercelProductionUrl,
} from "../src/core/deploy.js";

describe("deploy plan", () => {
  it("names the service after the package", () => {
    expect(serviceName("@acme/My App")).toBe("my-app");
    expect(serviceName("---")).toBe("web");
  });

  it("adds Redis only with the redis cache", () => {
    expect(databasesFor({ cache: "redis" })).toEqual(["postgres", "redis"]);
    expect(databasesFor({ cache: "memory" })).toEqual(["postgres"]);
  });

  it("skips the databases whose URL comes from elsewhere", () => {
    expect(databasesFor({ cache: "redis" }, ["DATABASE_URL"])).toEqual(["redis"]);
    expect(databasesFor({ cache: "redis" }, ["DATABASE_URL", "REDIS_URL"])).toEqual([]);
  });

  it("tells local URLs from hosted ones", () => {
    expect(isLocalUrl("postgresql://postgres:postgres@localhost:5432/app")).toBe(true);
    expect(isLocalUrl("redis://127.0.0.1:6379")).toBe(true);
    expect(isLocalUrl("postgres://u:p@[::1]/app")).toBe(true);
    expect(isLocalUrl("postgres://u:p@host.docker.internal/app")).toBe(true);
    expect(isLocalUrl("postgresql://postgres.abc:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres")).toBe(false);
    expect(isLocalUrl("rediss://default:pw@eu1-x.upstash.io:6379")).toBe(false);
  });

  it("takes hosted database URLs from the env file, for the databases the project uses", () => {
    const envFile = { DATABASE_URL: "postgresql://u:p@db.supabase.co/postgres", REDIS_URL: "rediss://default:pw@x.upstash.io:6379" };
    expect(externalDatabaseUrls({ cache: "redis" }, envFile)).toEqual(envFile);
    expect(externalDatabaseUrls({ cache: "memory" }, envFile)).toEqual({ DATABASE_URL: envFile.DATABASE_URL });
    expect(externalDatabaseUrls({ cache: "redis" }, { DATABASE_URL: "postgresql://localhost/dev", REDIS_URL: "" })).toEqual({});
  });

  it("reads the example's variable names once each", () => {
    expect(exampleKeys("# comment\r\nDATABASE_URL=x\nDATABASE_URL=y\nSMTP_URL=\n  REDIS_URL=\nlower=1\n")).toEqual([
      "DATABASE_URL",
      "SMTP_URL",
      "REDIS_URL",
    ]);
  });

  it("reads env files with quotes, export, and comments", () => {
    expect(parseEnvFile('export A=1\nB="two words"\nC=three # note\n# D=4\nE=\'x#y\'\n')).toEqual({
      A: "1",
      B: "two words",
      C: "three",
      E: "x#y",
    });
  });

  it("drops a comment after a quoted value, and keeps # inside the quotes", () => {
    expect(parseEnvFile('STRIPE_SECRET_KEY="sk_live_abc" # production key\nSMTP_URL=\'smtps://u:p#1@mail\'  # mail\n')).toEqual({
      STRIPE_SECRET_KEY: "sk_live_abc",
      SMTP_URL: "smtps://u:p#1@mail",
    });
  });

  const base = {
    modules: { auth: "better-auth", cache: "redis" },
    keys: ["NODE_ENV", "NEXT_PUBLIC_APP_URL", "DATABASE_URL", "BETTER_AUTH_SECRET", "REDIS_URL", "SMTP_URL", "STRIPE_SECRET_KEY"],
    url: "https://my-app.up.railway.app",
    existing: {},
    envFile: {},
    secret: () => "s3cret",
  };

  it("provides database references, the URL, the port, and a Better Auth secret", () => {
    const plan = planVariables(base);
    expect(plan.set).toMatchObject({
      NODE_ENV: "production",
      PORT: "3000",
      DATABASE_URL: "${{Postgres.DATABASE_URL}}",
      REDIS_URL: "${{Redis.REDIS_URL}}",
      APP_URL: "https://my-app.up.railway.app",
      NEXT_PUBLIC_APP_URL: "https://my-app.up.railway.app",
      BETTER_AUTH_SECRET: "s3cret",
    });
    expect(plan.unset).toEqual(["SMTP_URL", "STRIPE_SECRET_KEY"]);
  });

  it("keeps an existing secret, and counts the service's own values as set", () => {
    const plan = planVariables({ ...base, existing: { BETTER_AUTH_SECRET: "kept", SMTP_URL: "smtp://x" } });
    expect(plan.set.BETTER_AUTH_SECRET).toBeUndefined();
    expect(plan.unset).toEqual(["STRIPE_SECRET_KEY"]);
  });

  it("takes --env-file values, but not a local database URL", () => {
    const plan = planVariables({
      ...base,
      envFile: { STRIPE_SECRET_KEY: "sk_live_x", DATABASE_URL: "postgresql://localhost/dev", SMTP_URL: "" },
    });
    expect(plan.set.STRIPE_SECRET_KEY).toBe("sk_live_x");
    expect(plan.set.DATABASE_URL).toBe("${{Postgres.DATABASE_URL}}");
    expect(plan.unset).toEqual(["SMTP_URL"]);
  });

  it("uses hosted database URLs from --env-file instead of Railway's databases", () => {
    const plan = planVariables({
      ...base,
      envFile: { DATABASE_URL: "postgresql://u:p@db.supabase.co/postgres", REDIS_URL: "rediss://default:pw@x.upstash.io:6379" },
    });
    expect(plan.set).toMatchObject({ DATABASE_URL: "postgresql://u:p@db.supabase.co/postgres", REDIS_URL: "rediss://default:pw@x.upstash.io:6379" });
    const mixed = planVariables({ ...base, envFile: { DATABASE_URL: "postgresql://u:p@db.supabase.co/postgres" } });
    expect(mixed.set).toMatchObject({ DATABASE_URL: "postgresql://u:p@db.supabase.co/postgres", REDIS_URL: "${{Redis.REDIS_URL}}" });
  });

  it("leaves a database URL the service keeps out of the plan", () => {
    const plan = planVariables({ ...base, existing: { DATABASE_URL: "postgresql://u:p@db.supabase.co/postgres" }, databases: { REDIS_URL: "${{Redis.REDIS_URL}}" } });
    expect(plan.set).not.toHaveProperty("DATABASE_URL");
    expect(plan.unset).not.toContain("DATABASE_URL");
  });

  it("needs no secret without Better Auth", () => {
    expect(planVariables({ ...base, modules: { auth: "none", cache: "memory" } }).set).not.toHaveProperty("BETTER_AUTH_SECRET");
  });
});

describe("Railway CLI output", () => {
  it("finds the domain in JSON or text", () => {
    expect(parseRailwayDomain('{"domain":"My-App-production.up.railway.app"}')).toBe("my-app-production.up.railway.app");
    expect(parseRailwayDomain("Service Domain: https://web-1a2b.up.railway.app\n")).toBe("web-1a2b.up.railway.app");
    expect(parseRailwayDomain("No domains")).toBeNull();
  });

  it("finds service names wherever status puts them", () => {
    const status = {
      name: "my-app",
      services: { edges: [{ node: { name: "Postgres" } }, { node: { name: "my-app" } }] },
      environments: [{ name: "production" }],
    };
    expect(serviceNames(status).sort()).toEqual(["Postgres", "my-app"]);
    expect(serviceNames({ name: "project only" })).toEqual([]);
  });

  it("finds the deployment railway up started", () => {
    const output =
      "Indexing...\nUploading...\n  Deployment: https://railway.com/project/54fc3711-029a-4c04-96ff-90cee90497ab/service/5f49d436-3a6b-4c5b-a456-8c0ffb2461e6?id=8a3c507c-d1a0-4bd9-9cab-5b66f1e2b568\n";
    expect(parseDeploymentId(output)).toBe("8a3c507c-d1a0-4bd9-9cab-5b66f1e2b568");
    expect(parseDeploymentId("Uploading...")).toBeNull();
  });

  it("reads a deployment's status by id, or the newest since the upload", () => {
    // The shape `railway deployment list --json` returned in a live run, newest first.
    const list = JSON.stringify([
      { id: "0118e860-8f28-4e31-b31c-3f9bdf5f1580", status: "BUILDING", createdAt: "2026-10-13T17:39:10.396Z", meta: {} },
      { id: "8a3c507c-d1a0-4bd9-9cab-5b66f1e2b568", status: "FAILED", createdAt: "2026-10-13T17:27:34.000Z" },
    ]);
    expect(deploymentStatus(list, "8a3c507c-d1a0-4bd9-9cab-5b66f1e2b568", new Date())).toEqual({
      id: "8a3c507c-d1a0-4bd9-9cab-5b66f1e2b568",
      status: "FAILED",
    });
    expect(deploymentStatus(list, null, new Date("2026-10-13T17:39:08Z"))?.status).toBe("BUILDING");
    // Not listed yet, or not JSON: no status, so the caller keeps waiting.
    expect(deploymentStatus(list, null, new Date("2026-10-13T18:00:00Z"))).toBeNull();
    expect(deploymentStatus("Recent Deployments", null, new Date())).toBeNull();
  });

  it("reads variables as an object or a list", () => {
    expect(parseVariables('{"A":"1","B":2}')).toEqual({ A: "1", B: "2" });
    expect(parseVariables('[{"name":"A","value":"1"}]')).toEqual({ A: "1" });
    expect(parseVariables("not json")).toEqual({});
  });
});

describe("Railway configuration as code", () => {
  it("reads the CLI version and checks the 5.42.1 minimum", () => {
    expect(railwayCliVersion("railway 5.67.1\n")).toEqual([5, 67, 1]);
    expect(railwayCliVersion("timeout (GNU coreutils) 8.32")).toBeNull();
    expect(meetsMinimumCli([5, 67, 1])).toBe(true);
    expect(meetsMinimumCli([5, 42, 1])).toBe(true);
    expect(meetsMinimumCli([5, 42, 0])).toBe(false);
    expect(meetsMinimumCli([4, 99, 9])).toBe(false);
    expect(meetsMinimumCli([6, 0, 0])).toBe(true);
  });

  it("writes the settings railway.json had, for the project's own service", () => {
    const source = railwayIacSource("edge-notes");
    expect(source).toContain('import { defineRailway, project, service } from "railway/iac";');
    expect(source).toContain('export const partial = "edge-notes";');
    expect(source).toContain('service("edge-notes", {');
    expect(source).toContain('preDeploy: "node /app/migrate.mjs"');
    expect(source).toContain('healthcheck: "/api/health"');
    expect(source).toContain("healthcheckTimeout: 60");
    // Variables stay with deploy and the dashboard; no region, so Railway's default applies.
    expect(source).toContain("variables: { managed: false }");
    expect(source).not.toContain("replicas");
  });
});

describe("Fly.io", () => {
  it("reads the app and region fly launch writes, only above the first table", () => {
    const toml = 'app = "my-app-3f2a"\nprimary_region = "cdg"\n\n[build]\n  app = "not-this"\n';
    expect(flyTomlValue(toml, "app")).toBe("my-app-3f2a");
    expect(flyTomlValue(toml, "primary_region")).toBe("cdg");
    expect(flyTomlValue("[build]\n  dockerfile = \"Dockerfile\"\n", "app")).toBeNull();
    expect(flyAppUrl("my-app-3f2a")).toBe("https://my-app-3f2a.fly.dev");
  });

  it("finds the Redis URL and the secret names", () => {
    expect(parseRedisUrl("Your database is ready.\nRedis URL: redis://default:pw@fly-x.upstash.io:6379\n")).toBe(
      "redis://default:pw@fly-x.upstash.io:6379",
    );
    expect(parseRedisUrl("nothing here")).toBeNull();
    expect(flySecretNames('[{"Name":"DATABASE_URL","Digest":"x"},{"name":"APP_URL"}]')).toEqual(["DATABASE_URL", "APP_URL"]);
    expect(flySecretNames("not json")).toEqual([]);
  });

  it("imports secrets as NAME=VALUE lines, and refuses a value with a line break", () => {
    expect(flySecretsInput({ A: "1", B: "two words" })).toBe("A=1\nB=two words");
    expect(() => flySecretsInput({ KEY: "line\nbreak" })).toThrow(/line break/);
  });

  it("plans the secrets with DATABASE_URL attached by Fly and Redis from Upstash", () => {
    const plan = planVariables({
      modules: { auth: "better-auth", cache: "redis" },
      keys: ["DATABASE_URL", "REDIS_URL", "BETTER_AUTH_SECRET", "SMTP_URL"],
      url: "https://my-app.fly.dev",
      existing: {},
      envFile: { DATABASE_URL: "postgresql://localhost/dev" },
      secret: () => "s3cret",
      databases: { REDIS_URL: "redis://upstash" },
      attached: ["DATABASE_URL"],
    });
    expect(plan.set).not.toHaveProperty("DATABASE_URL");
    expect(plan.set).toMatchObject({ REDIS_URL: "redis://upstash", NEXT_PUBLIC_APP_URL: "https://my-app.fly.dev", BETTER_AUTH_SECRET: "s3cret" });
    expect(plan.unset).toEqual(["SMTP_URL"]);
  });

  it("plans the secrets with a hosted DATABASE_URL from the env file, and nothing attached", () => {
    const plan = planVariables({
      modules: { auth: "better-auth", cache: "redis" },
      keys: ["DATABASE_URL", "REDIS_URL", "BETTER_AUTH_SECRET"],
      url: "https://my-app.fly.dev",
      existing: {},
      envFile: { DATABASE_URL: "postgresql://u:p@db.supabase.co/postgres" },
      secret: () => "s3cret",
      databases: { REDIS_URL: "redis://upstash" },
    });
    expect(plan.set).toMatchObject({ DATABASE_URL: "postgresql://u:p@db.supabase.co/postgres", REDIS_URL: "redis://upstash" });
    expect(plan.unset).toEqual([]);
  });
});

describe("Vercel", () => {
  it("needs a CLI with vercel api", () => {
    expect(meetsMinimumCli([64, 0, 2], minimumVercelCli)).toBe(true);
    expect(meetsMinimumCli([50, 5, 1], minimumVercelCli)).toBe(true);
    expect(meetsMinimumCli([50, 4, 9], minimumVercelCli)).toBe(false);
    expect(railwayCliVersion("Vercel CLI 64.0.2")).toEqual([64, 0, 2]);
  });

  it("reads the project and its production variables", () => {
    expect(parseVercelProject('{"id":"prj_1","name":"my-app","rootDirectory":"apps/web"}')).toEqual({
      id: "prj_1",
      name: "my-app",
      rootDirectory: "apps/web",
    });
    expect(parseVercelProject('{"id":"prj_1","name":"my-app","rootDirectory":null}')?.rootDirectory).toBeNull();
    expect(parseVercelProject('{"error":{"code":"not_found"}}')).toBeNull();
    const envs = JSON.stringify({
      envs: [
        { key: "NEXT_PUBLIC_APP_URL", value: "https://my-app.vercel.app", type: "plain", target: ["production"] },
        { key: "BETTER_AUTH_SECRET", value: "eyJ...", type: "encrypted", target: ["production", "preview"] },
        { key: "PREVIEW_ONLY", value: "x", type: "plain", target: ["preview"] },
      ],
    });
    expect(parseVercelEnv(envs)).toEqual({ NEXT_PUBLIC_APP_URL: "https://my-app.vercel.app", BETTER_AUTH_SECRET: "(set)" });
    expect(parseVercelEnv("not json")).toEqual({});
  });

  it("sets production variables, encrypted except the public URL", () => {
    expect(vercelEnvBody({ APP_URL: "https://a.vercel.app", DATABASE_URL: "postgres://x" })).toEqual([
      { key: "APP_URL", value: "https://a.vercel.app", type: "plain", target: ["production"] },
      { key: "DATABASE_URL", value: "postgres://x", type: "encrypted", target: ["production"] },
    ]);
  });

  it("finds the deployment URL and the production alias Vercel assigned", () => {
    expect(parseVercelDeploymentUrl("Inspect: https://vercel.com/x\nhttps://my-app-abc123-me.vercel.app\n")).toBe(
      "https://my-app-abc123-me.vercel.app",
    );
    const deployment = JSON.stringify({
      alias: ["my-app-me.vercel.app", "my-app-git-main-me.vercel.app", "my-app-five.vercel.app", "my-app-abc123-me.vercel.app"],
    });
    expect(vercelProductionUrl(deployment, "https://my-app-abc123-me.vercel.app")).toBe("https://my-app-me.vercel.app");
    expect(vercelProductionUrl('{"alias":[]}', "https://x.vercel.app")).toBeNull();
  });

  it("writes a .vercelignore that keeps .env files out of the upload", () => {
    const ignore = vercelIgnoreSource("node_modules/\n.env*\n!.env.example\n");
    expect(ignore).toContain("node_modules/");
    expect(ignore.match(/^\.env\*$/gm)).toHaveLength(1);
    expect(ignoresEnvFiles(ignore)).toBe(true);
    expect(vercelIgnoreSource("node_modules/\n")).toContain(".env*\n!.env.example\n");
    expect(ignoresEnvFiles("node_modules\n")).toBe(false);
    expect(ignoresEnvFiles("/.env.*\n")).toBe(true);
  });

  it("never takes a localhost public URL from the env file", () => {
    const plan = planVariables({
      modules: { auth: "none", cache: "memory" },
      keys: [],
      url: "https://my-app.vercel.app",
      existing: {},
      envFile: { NEXT_PUBLIC_APP_URL: "http://localhost:3000", APP_URL: "https://app.example.com" },
      secret: () => "s",
      databases: {},
    });
    expect(plan.set.NEXT_PUBLIC_APP_URL).toBe("https://my-app.vercel.app");
    expect(plan.set.APP_URL).toBe("https://app.example.com");
  });
});

describe("Netlify", () => {
  it("names the site from the package", () => {
    expect(netlifySiteName("my_App")).toBe("my-app");
    expect(netlifySiteName("x".repeat(70))).toHaveLength(63);
    expect(netlifySiteName("---")).toBe("web");
  });

  it("reads the site, its URL and base directory, and the teams", () => {
    expect(parseNetlifySite('{"id":"s1","name":"my-app","ssl_url":"https://my-app.netlify.app/","build_settings":{"base":"apps/web"}}')).toEqual({
      id: "s1",
      name: "my-app",
      url: "https://my-app.netlify.app",
      base: "apps/web",
    });
    expect(parseNetlifySite('{"id":"s1","name":"my-app"}')).toMatchObject({ url: "https://my-app.netlify.app", base: null });
    expect(parseNetlifySite('{"code":404,"message":"Not Found"}')).toBeNull();
    expect(parseNetlifyAccounts('[{"slug":"me"},{"slug":"team"}]')).toEqual(["me", "team"]);
    expect(parseNetlifyAccounts("Not logged in")).toEqual([]);
  });

  it("writes an env file Netlify imports as it is", () => {
    expect(netlifyEnvFile({ DATABASE_URL: "postgresql://u:p@h/db?sslmode=require&x=1", EMAIL_FROM: "It's me <a@b.c>" })).toBe(
      "DATABASE_URL='postgresql://u:p@h/db?sslmode=require&x=1'\nEMAIL_FROM=\"It's me <a@b.c>\"\n",
    );
    expect(() => netlifyEnvFile({ KEY: "a\nb" })).toThrow(/line break/);
  });

  it("finds the URL in netlify deploy --json output after the build log", () => {
    const output = 'Building {site}\n{\n  "site_id": "s1",\n  "deploy_url": "https://abc--my-app.netlify.app",\n  "url": "https://my-app.netlify.app"\n}\n';
    expect(parseNetlifyDeploy(output)).toBe("https://my-app.netlify.app");
    expect(parseNetlifyDeploy("no json")).toBeNull();
  });
});

describe("Render", () => {
  it("builds from GitHub, GitLab, or Bitbucket remotes", () => {
    expect(renderRepoUrl("git@github.com:me/my-app.git")).toBe("https://github.com/me/my-app");
    expect(renderRepoUrl("https://github.com/me/my-app.git\n")).toBe("https://github.com/me/my-app");
    expect(renderRepoUrl("https://token@gitlab.com/group/sub/app")).toBe("https://gitlab.com/group/sub/app");
    expect(renderRepoUrl("ssh://git@bitbucket.org/me/app.git")).toBe("https://bitbucket.org/me/app");
    expect(renderRepoUrl("https://example.com/me/app.git")).toBeNull();
    expect(renderRepoUrl("")).toBeNull();
  });

  it("creates a Docker web service that migrates before each release", () => {
    const body = renderServiceBody({ name: "my-app", ownerId: "tea_1", repo: "https://github.com/me/my-app", branch: "main", values: { DATABASE_URL: "postgres://x" } });
    expect(body).toMatchObject({
      type: "web_service",
      name: "my-app",
      ownerId: "tea_1",
      repo: "https://github.com/me/my-app",
      branch: "main",
      serviceDetails: { runtime: "docker", plan: "starter", healthCheckPath: "/api/health", preDeployCommand: "node /app/migrate.mjs" },
      envVars: [{ key: "DATABASE_URL", value: "postgres://x" }],
    });
  });

  it("reads services, workspaces, and variables from Render's API", () => {
    const list = [
      { service: { id: "srv-2", name: "my-app-old", serviceDetails: { url: "https://my-app-old.onrender.com" } } },
      { service: { id: "srv-1", name: "my-app", serviceDetails: { url: "https://my-app-x1.onrender.com/" } } },
    ];
    expect(parseRenderService(list, "my-app")).toEqual({ id: "srv-1", name: "my-app", url: "https://my-app-x1.onrender.com" });
    expect(parseRenderService([], "my-app")).toBeNull();
    expect(parseRenderService({ service: { id: "srv-3", name: "new", serviceDetails: {} } })).toEqual({ id: "srv-3", name: "new", url: null });
    expect(parseRenderOwners([{ owner: { id: "tea_1", name: "Me" } }, { cursor: "x" }])).toEqual([{ id: "tea_1", name: "Me" }]);
    expect(parseRenderEnv([{ envVar: { key: "BETTER_AUTH_SECRET", value: "s" } }, { envVar: { key: "X" } }])).toEqual({ BETTER_AUTH_SECRET: "s", X: "(set)" });
    expect(parseRenderEnv(null)).toEqual({});
  });
});

describe("parseCliArgs deploy", () => {
  it("takes --env-file, for deploy only", () => {
    expect(parseCliArgs(["deploy", "--env-file", ".env.production"])).toMatchObject({
      command: { name: "deploy" },
      envFile: ".env.production",
    });
    expect(() => parseCliArgs(["my-app", "--env-file", "x"])).toThrow(/only applies to deploy/);
    expect(() => parseCliArgs(["deploy", "web"])).toThrow(/Usage: deploy/);
  });
});
