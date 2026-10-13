import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/args.js";
import {
  databasesFor,
  exampleKeys,
  parseEnvFile,
  parseRailwayDomain,
  parseVariables,
  planVariables,
  serviceName,
  serviceNames,
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

  it("takes --env-file values, but never over the database references", () => {
    const plan = planVariables({
      ...base,
      envFile: { STRIPE_SECRET_KEY: "sk_live_x", DATABASE_URL: "postgresql://localhost/dev", SMTP_URL: "" },
    });
    expect(plan.set.STRIPE_SECRET_KEY).toBe("sk_live_x");
    expect(plan.set.DATABASE_URL).toBe("${{Postgres.DATABASE_URL}}");
    expect(plan.unset).toEqual(["SMTP_URL"]);
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

  it("reads variables as an object or a list", () => {
    expect(parseVariables('{"A":"1","B":2}')).toEqual({ A: "1", B: "2" });
    expect(parseVariables('[{"name":"A","value":"1"}]')).toEqual({ A: "1" });
    expect(parseVariables("not json")).toEqual({});
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
