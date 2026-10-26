// What deploy writes for Docker Compose, and what it does with the files already there. The
// terminal output is replaced, so the messages can be read.
import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log, note } from "@clack/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "../src/cli/args.js";
import { caddyfileSource, dockerComposeSource, fullstackService, releaseImagesPath, releaseImagesWorkflowSource } from "../src/core/deploy.js";
import type { ProjectService } from "../src/core/manifest.js";
import type { Project } from "../src/core/project.js";
import { deployWithDocker } from "../src/deploy-docker.js";
import { temporaryDirectory } from "./helpers.js";

vi.mock("@clack/prompts", async (importOriginal) => {
  const prompts = await importOriginal<typeof import("@clack/prompts")>();
  return {
    ...prompts,
    note: vi.fn(),
    outro: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), success: vi.fn(), message: vi.fn(), error: vi.fn(), step: vi.fn() },
  };
});

const nextExample = "NODE_ENV=development\nNEXT_PUBLIC_APP_URL=http://localhost:3000\nDATABASE_URL=\n";
const nextKeys = ["NODE_ENV", "NEXT_PUBLIC_APP_URL", "DATABASE_URL"];

/** A generated project's provenance, in a folder with its .env.example. */
async function project(services: Record<string, ProjectService> = {}, example = nextExample): Promise<Project> {
  const root = await temporaryDirectory();
  await writeFile(join(root, ".env.example"), example);
  return {
    root,
    identity: { packageName: "@acme/My-App", displayName: "My App" },
    cliVersion: "0.41.1",
    starterRepository: "Clubedge/clubedge-starter",
    starterRef: "v0.26.1",
    stacks: {},
    modules: { deploy: "docker" },
    services,
  };
}

const deploy = (target: Project, ...flags: string[]) => deployWithDocker(parseCliArgs(["deploy", ...flags]), target, "pnpm clubedge");
const steps = () => String(vi.mocked(note).mock.calls.at(-1)?.[0]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deploy with Docker Compose", () => {
  it("writes compose.yaml, the Caddyfile, and the release workflow for a full-stack app", async () => {
    const target = await project();
    await deploy(target);
    const services = { framework: fullstackService };
    expect(await readFile(join(target.root, "compose.yaml"), "utf8")).toBe(dockerComposeSource("my-app", services, nextKeys));
    expect(await readFile(join(target.root, "Caddyfile"), "utf8")).toBe(caddyfileSource(services));
    expect(await readFile(join(target.root, releaseImagesPath), "utf8")).toBe(releaseImagesWorkflowSource(services, nextKeys));
    // The image compiles the public URL in, and migrates before the app starts.
    expect(steps()).toContain("They compile in NEXT_PUBLIC_APP_URL: set the ones you use as repository variables first.");
    expect(steps()).toContain("docker compose --env-file .env.production run --rm web node /app/migrate.mjs");
    expect(steps()).toContain("docker compose --env-file .env.production up -d");
  });

  it("migrates in a frontend's API, whose own example lists its variables", async () => {
    const service = { healthPath: "/", platforms: ["docker", "railway"] };
    const target = await project(
      {
        framework: { ...service, id: "web", role: "frontend", app: "apps/web", dockerfile: "Dockerfile", port: 3000 },
        api: { ...service, id: "api", role: "api", app: "apps/api", dockerfile: "apps/api/Dockerfile", port: 3001 },
      },
      "API_URL=http://127.0.0.1:3001\nVITE_API_URL=\n",
    );
    await deploy(target);
    expect(await readFile(join(target.root, "Caddyfile"), "utf8")).toContain("\treverse_proxy web:3000\n");
    expect(steps()).toContain("the variables of .env.example and apps/api/.env.example");
    expect(steps()).toContain("run --rm api node /app/migrate.mjs");
  });

  it("runs an API without a web app as the public app, behind Caddy", async () => {
    const api: ProjectService = { id: "api", role: "api", app: "apps/api", dockerfile: "apps/api/Dockerfile", port: 3001, healthPath: "/api/health", platforms: ["docker", "railway"] };
    const target = { ...(await project({ api })), stacks: { framework: "none", api: "hono", mobile: "expo" } };
    await mkdir(join(target.root, "apps/api"), { recursive: true });
    await writeFile(join(target.root, "apps/api/.env.example"), "PORT=3001\nBETTER_AUTH_URL=http://localhost:3001\nDATABASE_URL=\n");
    await deploy(target);

    const compose = await readFile(join(target.root, "compose.yaml"), "utf8");
    expect(compose).toBe(dockerComposeSource("my-app", { api }, ["PORT", "BETTER_AUTH_URL", "DATABASE_URL"]));
    // Caddy passes it the client's address, and Better Auth, which runs in it, gets the public URL.
    expect(compose).toContain("      TRUSTED_PROXY_HOPS: ${TRUSTED_PROXY_HOPS:-1}\n");
    expect(compose).toContain("      BETTER_AUTH_URL: ${BETTER_AUTH_URL:-https://${DOMAIN}}\n");
    expect(compose).not.toContain("Reached only through");
    expect(compose).toMatch(/ {4}depends_on:\n {6}- api\n\nvolumes:/);
    expect(await readFile(join(target.root, "Caddyfile"), "utf8")).toContain("\treverse_proxy api:3001\n");
    expect(steps()).toContain("In .env.production: DOMAIN, your domain, and the variables of apps/api/.env.example.");
    expect(steps()).toContain("run --rm api node /app/migrate.mjs");
  });

  it("leaves what it wrote alone, keeps a changed Caddyfile, and never overwrites compose.yaml", async () => {
    const target = await project();
    await deploy(target);
    await deploy(target);
    expect(vi.mocked(log.info)).toHaveBeenLastCalledWith("compose.yaml, the Caddyfile, and the workflow are up to date.");
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();

    const caddyfile = join(target.root, "Caddyfile");
    await writeFile(caddyfile, "{$DOMAIN} {\n\tencode zstd gzip\n\treverse_proxy web:3000\n}\n");
    await deploy(target);
    expect(await readFile(caddyfile, "utf8")).toContain("encode zstd gzip");
    expect(vi.mocked(log.warn).mock.calls[0]?.[0]).toMatch(/^Kept your Caddyfile/);

    await writeFile(join(target.root, "compose.yaml"), "services: {}\n");
    await expect(deploy(target)).rejects.toThrow(/compose\.yaml already exists and differs/);
    expect(await readFile(join(target.root, "compose.yaml"), "utf8")).toBe("services: {}\n");
  });

  it("takes a file checked out with Windows line endings as its own", async () => {
    const target = await project();
    await deploy(target);
    const compose = join(target.root, "compose.yaml");
    await writeFile(compose, (await readFile(compose, "utf8")).replace(/\n/g, "\r\n"));
    await deploy(target);
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });

  const hasGit = spawnSync("git", ["--version"]).status === 0;
  it.skipIf(!hasGit)("writes nothing on a dry run, and names the registry of the GitHub remote", async () => {
    const target = await project();
    const git = (...argv: string[]) => spawnSync("git", argv, { cwd: target.root });
    git("init", "-q");
    git("remote", "add", "origin", "git@github.com:Acme/My-App.git");
    await deploy(target, "--dry-run");
    expect((await readdir(target.root)).sort()).toEqual([".env.example", ".git"]);
    expect(String(vi.mocked(log.message).mock.calls[0]?.[0])).toContain("into ghcr.io/acme/my-app-<service>");
  });

  it("refuses an app whose stack doesn't declare Docker", async () => {
    const service = { healthPath: "/", platforms: ["railway"] };
    const target = await project({
      framework: { ...service, id: "web", role: "frontend", app: "apps/web", dockerfile: "Dockerfile", port: 3000 },
      api: { ...service, id: "api", role: "api", app: "apps/api", dockerfile: "apps/api/Dockerfile", port: 3001 },
    });
    await expect(deploy(target)).rejects.toThrow(/do not declare Docker deployment support for framework, api/);
  });
});
