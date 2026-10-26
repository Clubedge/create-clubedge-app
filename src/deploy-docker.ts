// `deploy` with Docker Compose, on a server of your own. It writes compose.yaml, which runs each
// app's image behind Caddy (HTTPS for your domain, with certificates Caddy obtains and renews), the
// Caddyfile, and .github/workflows/release-images.yml, which publishes the images to GitHub's
// container registry for each release. It creates nothing anywhere else: the closing steps say
// what to set and run on the server.
import { log, note, outro } from "@clack/prompts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { UsageError, type CliArgs } from "./cli/args.js";
import { bold, dim } from "./cli/ui.js";
import {
  buildArgumentKeys,
  caddyfileSource,
  dockerComposeSource,
  exampleKeys,
  fullstackService,
  ghcrImagePrefix,
  publicService,
  releaseImagesPath,
  releaseImagesWorkflowSource,
  serviceName,
} from "./core/deploy.js";
import { FRAMEWORK_SLOT } from "./core/manifest.js";
import type { Project } from "./core/project.js";
import { runCapture } from "./utils/process.js";

const composePath = "compose.yaml";

export async function deployWithDocker(args: CliArgs, project: Project, cli: string): Promise<void> {
  const root = project.root;
  const separate = Object.entries(project.services).filter(([, service]) => service.role !== "fullstack");
  const unsupported = separate.filter(([, service]) => !service.platforms.includes("docker"));
  if (unsupported.length) {
    throw new UsageError(`The selected stacks do not declare Docker deployment support for ${unsupported.map(([slot]) => slot).join(", ")}.`);
  }
  // A full-stack framework's stack records no service: the app is the root Dockerfile's image.
  // Without a web app, the API is the project's one service.
  const apiOnly = project.stacks[FRAMEWORK_SLOT] === "none";
  const fullstack = Object.values(project.services).find(({ role }) => role === "fullstack") ?? fullstackService;
  const services = separate.length > 1 || apiOnly ? Object.fromEntries(separate) : { [FRAMEWORK_SLOT]: fullstack };
  const apps = Object.values(services);
  const api = apps.find(({ role }) => role === "api");
  const web = publicService(services);
  // The public app's variables: the frontend's or full-stack app's example, else the API's own.
  const publicExample = apiOnly && api ? `${api.app}/.env.example` : ".env.example";
  const keys = exampleKeys(await readFile(join(root, publicExample), "utf8").catch(() => ""));
  const files: Array<[string, string]> = [
    [composePath, dockerComposeSource(serviceName(project.identity.packageName), services, keys)],
    ["Caddyfile", caddyfileSource(services)],
    [releaseImagesPath, releaseImagesWorkflowSource(services, keys)],
  ];
  // deploy never overwrites a file that differs from what it writes: you may have changed it.
  const current = new Map<string, string | null>();
  for (const [path] of files) {
    current.set(path, await readFile(join(root, path), "utf8").then((text) => text.replace(/\r\n/g, "\n"), () => null));
  }
  const changed = files.filter(([path, source]) => current.get(path) != null && current.get(path) !== source).map(([path]) => path);
  const prefix = ghcrImagePrefix(await runCapture("git", ["remote", "get-url", "origin"], root).catch(() => ""));
  const registry = prefix ?? "ghcr.io/<owner>/<repository>";

  if (args.dryRun) {
    log.message(
      [
        `• ${composePath}: ${apps.map((service) => `${service.id} (${service.dockerfile}, port ${service.port})`).join(" and ")}${api && api !== web ? `; ${web.id} proxies /api to ${api.id} over the Compose network` : ""}`,
        `• Caddy in front, the only service with published ports (80 and 443): it serves https://<DOMAIN> and renews its certificates`,
        `• Caddyfile: every request for DOMAIN goes to ${web.id}:${web.port}`,
        `• ${releaseImagesPath}: each published GitHub release builds the images for linux/amd64 and linux/arm64 into ${registry}-<service>`,
        ...(changed.length ? [`• Already there and different, so ${changed.includes(composePath) ? "deploy would stop" : "kept"}: ${changed.join(", ")}`] : []),
      ].join("\n"),
    );
    outro("Dry run: nothing was written. Run deploy to write these files.");
    return;
  }
  // The steps below are about the compose.yaml deploy writes.
  if (changed.includes(composePath)) {
    throw new UsageError(
      `${composePath} already exists and differs from the one deploy writes, which runs the apps behind Caddy. deploy never overwrites it: review it, move it away, then run deploy again.`,
    );
  }

  const written: string[] = [];
  for (const [path, source] of files) {
    if (current.get(path) !== null) continue;
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
    written.push(path);
  }
  if (written.length) log.info(`Wrote ${written.join(", ")}. Commit ${written.length === 1 ? "it" : "them"}.`);
  else if (!changed.length) log.info("compose.yaml, the Caddyfile, and the workflow are up to date.");
  if (changed.length) {
    log.warn(`Kept your ${changed.join(" and ")}, which ${changed.length === 1 ? "differs" : "differ"} from what deploy writes. Move ${changed.length === 1 ? "it" : "them"} away and run deploy again for the generated version.`);
  }

  const examples = [...(apiOnly ? [] : [".env.example"]), ...apps.filter(({ role }) => role === "api").map(({ app }) => `${app}/.env.example`)];
  const compiled = apps.flatMap((service) => buildArgumentKeys(service, keys));
  // The service that owns the database runs the migrations: the API, else the full-stack app.
  const migrator = api ?? web;
  note(
    [
      `${bold("1")} In .env.production: DOMAIN, your domain, and the variables of ${examples.join(" and ")}.`,
      `  To run the released images: IMAGE_PREFIX=${registry}, and TAG=<version> to pin one.`,
      `${bold("2")} Point the domain's DNS A/AAAA records at the server: Caddy gets the HTTPS certificate.`,
      `${bold("3")} Publish a GitHub release: ${releaseImagesPath} builds the images into GHCR.`,
      ...(compiled.length ? [`  They compile in ${compiled.join(", ")}: set the ones you use as repository variables first.`] : []),
      "  The packages start private: docker login ghcr.io on the server with a read:packages token, or make them public.",
      `${bold("4")} On the server, with compose.yaml, the Caddyfile, and .env.production, migrate, then start:`,
      `  docker compose --env-file .env.production run --rm ${migrator.id} node /app/migrate.mjs`,
      `  docker compose --env-file .env.production up -d   ${dim("(--build builds the images there)")}`,
    ].join("\n"),
    "Run it on your server",
  );
  outro(`${dim("Logs")}   docker compose logs --follow\n${dim("Again")}  ${cli} deploy   ${dim("(writes what is missing, never over your changes)")}`);
}
