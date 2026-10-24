// `deploy`: a guided first deploy to Railway, with Railway's own CLI. It creates (or reuses) the
// project, the databases the env file doesn't point elsewhere, the app's service and domain, sets
// the production variables, and runs `railway up`; Railway then builds the image, runs the
// migrations, and checks /api/health.
import { cancel, confirm, isCancel, log, note, outro, spinner } from "@clack/prompts";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { UsageError, type CliArgs } from "./cli/args.js";
import { bold, dim } from "./cli/ui.js";
import { FRAMEWORK_SLOT } from "./core/manifest.js";
import {
  appPort,
  clientAddresses,
  databaseVariables,
  dockerComposeSource,
  databasesFor,
  deploymentStatus,
  exampleKeys,
  externalDatabaseUrls,
  finalStatuses,
  isLocalUrl,
  meetsMinimumCli,
  minimumRailwayCli,
  parseDeploymentId,
  parseEnvFile,
  parseRailwayDomain,
  parseVariables,
  planServicePair,
  planVariables,
  railwayCliVersion,
  railwayDatabases,
  railwayIacPath,
  railwayIacSource,
  railwayReferences,
  serviceName,
  serviceNames,
} from "./core/deploy.js";
import { neonDatabaseState } from "./core/neon.js";
import { readProject, type Project } from "./core/project.js";
import { savedDatabaseForUrl } from "./neon.js";
import { deployToFly } from "./deploy-fly.js";
import { deployPreview } from "./deploy-preview.js";
import { deployToNetlify } from "./deploy-netlify.js";
import { deployToRender } from "./deploy-render.js";
import { deployToVercel } from "./deploy-vercel.js";
import { cliCommand } from "./modify.js";
import { resolvePnpm } from "./steps/install.js";
import { pathExists } from "./utils/fs.js";
import { run, spawnCommand } from "./utils/process.js";

const railwayTermsUrl = "https://railway.com/legal/terms";
const deployDocsUrl = "https://starter.clubedge.live/docs/starter/deploy";

/**
 * The production env file: --env-file, else the project's .env.production when there is one. Its
 * values go on top of what the platform provides; its database URLs replace the platform's databases.
 */
async function readDeployEnv(args: CliArgs, project: Project): Promise<Record<string, string>> {
  const path = args.envFile ? resolve(process.cwd(), args.envFile) : join(project.root, ".env.production");
  if (!(await pathExists(path))) {
    if (args.envFile) throw new UsageError(`The env file ${args.envFile} does not exist.`);
    return {};
  }
  if (!args.envFile) log.info("Using .env.production (pass --env-file for another file).");
  const values = parseEnvFile(await readFile(path, "utf8"));
  const local = databasesFor(project.modules)
    .map((database) => databaseVariables[database])
    .filter((key) => values[key] && isLocalUrl(values[key]!));
  if (local.length) {
    log.warn(`${local.join(" and ")} in the env file point at this machine, which the deployed app can't reach: ignored, so deploy creates the platform's own.`);
  }
  // The free Neon database create made is deleted after 72 hours unless it is claimed.
  const saved = await savedDatabaseForUrl(values.DATABASE_URL);
  if (saved) {
    const state = await neonDatabaseState(saved);
    if (state.kind === "expired") {
      throw new UsageError("DATABASE_URL in the env file is a free Neon database that expired, and Neon deleted it. Point it at a database you keep.");
    }
    if (state.kind !== "claimed") {
      const left = state.kind === "unclaimed" ? `in ${state.hoursLeft} hours` : `after ${new Date(saved.expiresAt).toLocaleString()}`;
      log.warn(
        `DATABASE_URL is the free Neon database create-clubedge-app made: Neon deletes it ${left} unless you claim it. Run \`${await cliCommand(project)} neon claim\`, then put the new connection strings in the env file.`,
      );
    }
  }
  return values;
}

/** A Railway CLI to run, and the executable Railway's TypeScript SDK runs to check its version. */
export interface RailwayCli {
  command: string[];
  /** Set as `_` for every Railway command: railway/iac checks the CLI's version with `$_ --version`,
   * falling back to `railway` on PATH, which fails in PowerShell and behind npm's .cmd shims. */
  executable: string;
  /** npm's .cmd shims need a shell on Windows; a binary does not. */
  shell: boolean;
}

const windows = process.platform === "win32";
const binaryName = windows ? "railway.exe" : "railway";

async function cliVersion(command: string[], shell: boolean): Promise<[number, number, number] | null> {
  return await new Promise((resolveVersion) => {
    const [file, ...args] = command;
    const child = spawnCommand(file!, [...args, "--version"], { stdio: ["ignore", "pipe", "ignore"] }, shell);
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.once("error", () => resolveVersion(null));
    child.once("close", (code) => resolveVersion(code === 0 ? railwayCliVersion(out) : null));
  });
}

/** The railway.exe behind `railway` on PATH (npm installs a railway.cmd shim next to its package). */
async function installedBinary(): Promise<string | null> {
  if (!windows) return (await cliVersion(["railway"], false)) ? "railway" : null;
  const found = await new Promise<string>((resolveWhere) => {
    const child = spawn("where", ["railway"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.once("error", () => resolveWhere(""));
    child.once("close", () => resolveWhere(out));
  });
  for (const line of found.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    if (line.toLowerCase().endsWith(".exe")) return line;
    const shimmed = join(dirname(line), "node_modules", "@railway", "cli", "bin", binaryName);
    if (await pathExists(shimmed)) return shimmed;
  }
  return null;
}

/** Railway CLI binaries npx already downloaded, newest first: no download on a slow connection. */
async function cachedBinaries(): Promise<string[]> {
  const cache =
    process.env.npm_config_cache ||
    (windows && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "npm-cache") : join(homedir(), ".npm"));
  const found: Array<{ path: string; time: number }> = [];
  for (const entry of await readdir(join(cache, "_npx")).catch(() => [] as string[])) {
    const path = join(cache, "_npx", entry, "node_modules", "@railway", "cli", "bin", binaryName);
    const stats = await stat(path).catch(() => null);
    if (stats?.isFile()) found.push({ path, time: stats.mtimeMs });
  }
  return found.sort((a, b) => b.time - a.time).map((entry) => entry.path);
}

/**
 * A Railway CLI new enough for `.railway/railway.ts`: the installed one, then one npx already
 * downloaded, and only then a download through npx.
 */
export async function railwayCli(): Promise<RailwayCli> {
  const usable = async (binary: string) => {
    const version = await cliVersion([binary], false);
    return version !== null && meetsMinimumCli(version);
  };
  const installed = await installedBinary();
  if (installed && (await usable(installed))) return { command: [installed], executable: installed, shell: false };
  for (const binary of await cachedBinaries()) {
    if (await usable(binary)) return { command: [binary], executable: binary, shell: false };
  }
  await cliVersion(["npx", "--yes", "@railway/cli@latest"], windows);
  for (const binary of await cachedBinaries()) {
    if (await usable(binary)) return { command: [binary], executable: binary, shell: false };
  }
  throw new UsageError(
    `deploy needs Railway CLI ${minimumRailwayCli.join(".")} or newer. Install it with \`npm install -g @railway/cli\`, then run deploy again.`,
  );
}

interface RunOptions {
  /** Written to the command's stdin. */
  input?: string;
  /** Show the command's output and let it prompt (login). */
  inherit?: boolean;
}

export async function railway(cli: RailwayCli, args: string[], options: RunOptions = {}): Promise<string> {
  const [command, ...prefix] = cli.command;
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawnCommand(
      command!,
      [...prefix, ...args],
      { env: { ...process.env, _: cli.executable }, stdio: options.inherit ? "inherit" : ["pipe", "pipe", "pipe"] },
      cli.shell,
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    // close, not exit: it fires once stdout and stderr are fully read, so JSON output is never cut off.
    child.once("close", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new Error(`railway ${args[0]} failed${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : "."}`));
    });
    if (child.stdin) {
      // A command that exits before reading its input must not crash the CLI with EPIPE.
      child.stdin.on("error", () => {});
      child.stdin.end(options.input ?? "");
    }
  });
}

const attempt = async (run: () => Promise<string>) => run().catch(() => null);

async function agree(args: CliArgs, service: string, databases: Array<keyof typeof railwayDatabases>, external: string[]): Promise<boolean> {
  const hosted = databases.map((db) => railwayDatabases[db]).join(" and ");
  note(
    [
      "This deploys the project to Railway, in your Railway account:",
      "",
      `• A project${hosted ? ` with ${hosted}` : ""}, and a service "${service}" with a public *.up.railway.app domain.`,
      ...(external.length ? [`• ${external.join(" and ")} from the env file: those databases stay where they are, and Railway runs the app.`] : []),
      "• The production variables Railway can provide; your provider keys come from the env file.",
      "• Railway builds the Dockerfile, runs the migrations before the release, and checks /api/health; the first build takes several minutes.",
      `• The service's settings go in ${railwayIacPath}, which replaces railway.json; the railway package is added to read it.`,
      "",
      `Railway bills usage on your plan. Running deploy again reuses all of it. Railway's terms: ${railwayTermsUrl}`,
    ].join("\n"),
    "Deploy to Railway",
  );
  if (args.yes) return true;
  if (!process.stdin.isTTY) throw new UsageError("deploy creates resources in your Railway account. Run it in a terminal to confirm, or pass --yes.");
  const answer = await confirm({ message: "Deploy?", initialValue: true });
  return !isCancel(answer) && answer;
}

async function deployRailwayServices(
  args: CliArgs,
  project: Project,
  cli: string,
  envFile: Record<string, string>,
): Promise<void> {
  const selected = Object.entries(project.services);
  const frontend = selected.find(([, item]) => item.role === "frontend");
  const api = selected.find(([, item]) => item.role === "api");
  if (!frontend || !api || selected.length !== 2) {
    throw new UsageError("Railway deployment currently supports one frontend and one API service in a decoupled project.");
  }
  const unsupported = selected.filter(([, service]) => !service.platforms.includes("railway"));
  if (unsupported.length) {
    throw new UsageError(`The selected stacks do not declare Railway deployment support for ${unsupported.map(([slot]) => slot).join(", ")}.`);
  }
  const [frontendSlot, frontendStack] = frontend;
  const [apiSlot, apiStack] = api;
  const baseName = serviceName(project.identity.packageName);
  const names = {
    frontend: serviceName(`${baseName}-${frontendStack.id}`),
    api: serviceName(`${baseName}-${apiStack.id}`),
  };
  const keys = exampleKeys(await readFile(join(project.root, ".env.example"), "utf8").catch(() => ""));
  const external = Object.keys(externalDatabaseUrls(project.modules, envFile));
  const requestedDatabases = databasesFor(project.modules, external);
  const serviceSummary = `${frontendSlot} (${frontendStack.dockerfile}) and ${apiSlot} (${apiStack.dockerfile})`;
  if (args.dryRun) {
    log.message([
      `Railway will create two services: ${names.frontend} (public, port ${frontendStack.port}) and ${names.api} (private, port ${apiStack.port}).`,
      `The frontend proxies /api to ${names.api} over Railway's private network.`,
      ...(requestedDatabases.length ? [`Databases: ${requestedDatabases.map((db) => railwayDatabases[db]).join(", ")}.`] : []),
      `Dockerfiles: ${frontendStack.dockerfile}, ${apiStack.dockerfile}. API migrations run before its release.`,
      `Variables from .env.production are applied to their corresponding services; ${railwayIacPath} records both service configurations.`,
    ].join("\n"));
    outro("Dry run: nothing was created. Run again without --dry-run to deploy.");
    return;
  }
  note(
    `This creates or updates Railway services ${names.frontend} and ${names.api}; publishes only the frontend, connects the services over Railway's private network, and runs migrations before the API release. Railway bills usage on your plan.`,
    "Deploy frontend and API to Railway",
  );
  if (!args.yes) {
    if (!process.stdin.isTTY) throw new UsageError("deploy creates Railway resources. Run it in a terminal to confirm, or pass --yes.");
    const answer = await confirm({ message: "Deploy?", initialValue: true });
    if (isCancel(answer) || !answer) return cancel("Nothing was deployed.");
  }

  const progress = spinner();
  progress.start("Preparing the Railway CLI");
  const rw = await railwayCli();
  process.chdir(project.root);
  if (!(await attempt(() => railway(rw, ["whoami"])))) {
    progress.stop("Signing in to Railway");
    if (!process.stdin.isTTY) throw new UsageError("Sign in to Railway first with `railway login`, or set RAILWAY_API_TOKEN.");
    await railway(rw, ["login"], { inherit: true });
    progress.start("Signed in");
  }
  progress.message("Finding or creating the Railway project");
  let status = await attempt(() => railway(rw, ["status", "--json"]));
  if (!status) {
    await railway(rw, ["init", "--name", baseName, "--json"]);
    status = await attempt(() => railway(rw, ["status", "--json"]));
  }
  let existing: string[] = [];
  try { existing = serviceNames(JSON.parse(status ?? "{}")); } catch { /* unknown status: add missing services */ }

  const listedApiVars = await attempt(() => railway(rw, ["variable", "list", "--service", names.api, "--json"]));
  if (listedApiVars === null && existing.includes(names.api)) {
    throw new Error(`Railway didn't list the variables of the API service "${names.api}", so deploy changed nothing. Run deploy again; if it keeps failing, check \`railway variable list --service ${names.api}\`.`);
  }
  const apiVars = parseVariables(listedApiVars ?? "");
  const kept = databasesFor(project.modules, external)
    .filter((database) => apiVars[databaseVariables[database]] && !existing.includes(railwayDatabases[database]))
    .map((database) => databaseVariables[database]);
  const databases = databasesFor(project.modules, [...external, ...kept]);

  for (const database of databases) {
    const name = railwayDatabases[database];
    if (!existing.includes(name)) await railway(rw, ["add", "--database", database]);
  }
  for (const name of Object.values(names)) {
    if (!existing.includes(name)) await railway(rw, ["add", "--service", name]);
  }

  const listed = await attempt(() => railway(rw, ["domain", "list", "--service", names.frontend]));
  const domain = parseRailwayDomain(listed ?? "") ?? parseRailwayDomain(
    await railway(rw, ["domain", "--service", names.frontend, "--port", String(frontendStack.port), "--json"]),
  );
  if (!domain) throw new Error("Railway created no frontend domain. Create one in its settings, then run deploy again.");
  const url = `https://${domain}`;

  const listedWebVars = await attempt(() => railway(rw, ["variable", "list", "--service", names.frontend, "--json"]));
  if (listedWebVars === null && existing.includes(names.frontend)) {
    throw new Error(`Railway didn't list the variables of the frontend service "${names.frontend}", so deploy changed nothing. Run deploy again; if it keeps failing, check \`railway variable list --service ${names.frontend}\`.`);
  }
  const webVars = parseVariables(listedWebVars ?? "");
  const plan = planServicePair({
    modules: project.modules,
    frontendKeys: keys,
    apiKeys: exampleKeys(await readFile(join(project.root, apiStack.app, ".env.example"), "utf8").catch(() => "")),
    url,
    existing: { frontend: webVars, api: apiVars },
    envFile,
    secret: () => randomBytes(32).toString("hex"),
    databases: railwayReferences(databases),
    ports: { frontend: frontendStack.port, api: apiStack.port },
    clientAddress: clientAddresses.railway,
  });
  const unset = [
    ...(plan.api.unset.length ? [`Not set on the API service: ${plan.api.unset.join(", ")}.`] : []),
    ...(plan.frontend.unset.length ? [`Not set on the frontend service: ${plan.frontend.unset.join(", ")}.`] : []),
  ];
  if (unset.length) {
    log.warn(`${unset.join("\n")}\nPass --env-file to supply values before deployment.`);
    if (process.stdin.isTTY && !args.yes) {
      const proceed = await confirm({ message: "Deploy anyway?", initialValue: true });
      if (isCancel(proceed) || !proceed) return cancel("Nothing was uploaded. Set the variables, then run deploy again.");
    }
  }
  for (const [key, value] of Object.entries(plan.api.set)) {
    if (apiVars[key] !== value) await railway(rw, ["variable", "set", key, "--stdin", "--service", names.api, "--skip-deploys"], { input: value });
  }
  for (const [key, value] of Object.entries(plan.frontend.set)) {
    if (webVars[key] !== value) await railway(rw, ["variable", "set", key, "--stdin", "--service", names.frontend, "--skip-deploys"], { input: value });
  }

  await mkdir(join(project.root, ".railway"), { recursive: true });
  const iacFile = join(project.root, railwayIacPath);
  const existingIac = await readFile(iacFile, "utf8").catch(() => "");
  if (existingIac && !existingIac.includes("The Railway service is named after the package") && !existingIac.includes("Generated from the selected stack packs")) {
    throw new UsageError(`${railwayIacPath} contains custom configuration. Review it and merge the generated two-service configuration before deploying.`);
  }
  await writeFile(iacFile, railwayIacSource(baseName, project.services));
  const packageJson = JSON.parse(await readFile(join(project.root, "package.json"), "utf8"));
  if (!packageJson.devDependencies?.railway && !packageJson.dependencies?.railway) {
    const pnpm = await resolvePnpm();
    if (!pnpm) throw new UsageError("pnpm was not found. Enable it with `corepack enable`, then run deploy again.");
    const [command, ...prefix] = pnpm;
    await run(command!, [...prefix, "add", "--save-dev", "--workspace-root", "railway"], project.root);
  }
  progress.message("Applying the two-service Railway configuration");
  await railway(rw, ["config", "apply", "--yes"]);

  const deployments = [] as Array<{ name: string; id: string | null; started: Date }>;
  for (const name of [names.api, names.frontend]) {
    progress.message(`Uploading ${name}`);
    const started = new Date();
    deployments.push({ name, id: parseDeploymentId(await railway(rw, ["up", "--service", name, "--detach"])), started });
  }
  for (const item of deployments) {
    let state = "QUEUED";
    const deadline = Date.now() + 45 * 60_000;
    while (!(finalStatuses as readonly string[]).includes(state) && Date.now() < deadline) {
      progress.message(`Railway ${item.name}: ${state.toLowerCase()}`);
      await new Promise((wait) => setTimeout(wait, 10_000));
      const list = await attempt(() => railway(rw, ["deployment", "list", "--service", item.name, "--json"]));
      state = deploymentStatus(list ?? "", item.id, item.started)?.status ?? state;
    }
    if (state !== "SUCCESS") throw new Error(`Railway's ${item.name} deployment ended as ${state}. Read its build and runtime logs with railway logs --service ${item.name}.`);
  }
  progress.stop("Both Railway services are healthy");
  note(`${bold("Frontend")} ${url}\n${bold("Services")} ${names.frontend} and ${names.api}\n${bold("API")}      private to Railway`, "Deployed to Railway");
  outro(`${dim("Frontend logs")} railway logs --service ${names.frontend}\n${dim("API logs")}      railway logs --service ${names.api}\n${dim("Again")}          ${cli} deploy`);
  log.info(`Configured: ${serviceSummary}.`);
}

export async function deployProject(args: CliArgs): Promise<void> {
  const project = await readProject(process.cwd());
  const cli = await cliCommand(project);
  const platform = project.modules.deploy ?? "docker";
  const separateApps = Object.entries(project.services).filter(([, service]) => service.role !== "fullstack");
  const decoupledSlots = Object.keys(project.stacks).filter((slot) => slot !== FRAMEWORK_SLOT);
  if (decoupledSlots.length && separateApps.length < 2) {
    throw new UsageError(
      `This project has a frontend and ${decoupledSlots.join(", ")}, but does not record deployment services for them. Upgrade it to a Starter release whose stacks declare deployment, or build each app's Dockerfile and run them on any container host.`,
    );
  }
  if (args.preview) return await deployPreview(args, project, cli, await readDeployEnv(args, project));
  if (separateApps.length > 1 && platform === "railway") {
    return await deployRailwayServices(args, project, cli, await readDeployEnv(args, project));
  }
  if (separateApps.length > 1 && platform === "docker") {
    const unsupported = separateApps.filter(([, service]) => !service.platforms.includes("docker"));
    if (unsupported.length) {
      throw new UsageError(`The selected stacks do not declare Docker deployment support for ${unsupported.map(([slot]) => slot).join(", ")}.`);
    }
    const frontendKeys = exampleKeys(await readFile(join(project.root, ".env.example"), "utf8").catch(() => ""));
    const compose = dockerComposeSource(Object.fromEntries(separateApps), frontendKeys);
    if (args.dryRun) {
      log.message(`Docker Compose will start ${separateApps.map(([slot, service]) => `${slot} (${service.dockerfile}, port ${service.port})`).join(" and ")}; the frontend proxies /api to the API over the Compose network.`);
      outro("Dry run: nothing was written. Run deploy to generate compose.yaml.");
      return;
    }
    const path = join(project.root, "compose.yaml");
    if (await pathExists(path)) throw new UsageError("compose.yaml already exists. Review it and remove it before generating the stack configuration again.");
    await writeFile(path, compose);
    note(`Generated compose.yaml for ${separateApps.map(([slot]) => slot).join(" and ")}.`, "Docker Compose deployment");
    const examples = [".env.example", ...separateApps.filter(([, service]) => service.role === "api").map(([, service]) => `${service.app}/.env.example`)];
    outro(`Copy the variables of ${examples.join(" and ")} to .env.production and set their values, then run from the project root:\n  docker compose --env-file .env.production up --build -d\n\nThe frontend is published on its declared port; the API stays on the private Compose network.`);
    return;
  }
  if (separateApps.length > 1) {
    throw new UsageError(`The ${platform} deploy adapter does not yet support the selected ${separateApps.map(([slot]) => slot).join(" + ")} services. Select Docker Compose with \`${cli} add deploy docker\`, or deploy each Dockerfile separately.`);
  }
  if (platform === "fly") return await deployToFly(args, project, cli, await readDeployEnv(args, project));
  if (platform === "vercel") return await deployToVercel(args, project, cli, await readDeployEnv(args, project));
  if (platform === "netlify") return await deployToNetlify(args, project, cli, await readDeployEnv(args, project));
  if (platform === "render") return await deployToRender(args, project, cli, await readDeployEnv(args, project));
  if (platform !== "railway") {
    throw new UsageError(
      `deploy sets up Railway, Fly.io, Vercel, Netlify, and Render, and this project deploys with "${platform}". Switch with \`${cli} add deploy railway\` (or fly, vercel, netlify, render), or follow ${deployDocsUrl} for ${platform}.`,
    );
  }

  const service = serviceName(project.identity.packageName);
  const keys = exampleKeys(await readFile(join(project.root, ".env.example"), "utf8").catch(() => ""));
  const envFile = await readDeployEnv(args, project);
  const external = Object.keys(externalDatabaseUrls(project.modules, envFile));
  const databases = databasesFor(project.modules, external);
  const secret = () => randomBytes(32).toString("hex");

  if (args.dryRun) {
    const preview = planVariables({ modules: project.modules, keys, url: "https://<service>.up.railway.app", existing: {}, envFile, secret: () => "<generated>", clientAddress: clientAddresses.railway });
    log.message(
      [
        `• Railway project "${service}"${databases.length ? ` with ${databases.map((db) => railwayDatabases[db]).join(" and ")}` : ""}, and the service "${service}"`,
        ...(external.length ? [`• ${external.join(" and ")} from the env file, instead of Railway's databases`] : []),
        `• A *.up.railway.app domain for port ${appPort}`,
        `• ${railwayIacPath} (written if missing, with Railway's SDK added), applied with railway config apply`,
        `• Variables: ${Object.keys(preview.set).join(", ")}`,
        ...(preview.unset.length ? [`• Not set: ${preview.unset.join(", ")}`] : []),
        `• railway up: build, migrations, health check`,
      ].join("\n"),
    );
    outro("Dry run: nothing was created. Run again without --dry-run to deploy.");
    return;
  }

  if (!(await agree(args, service, databases, external))) {
    cancel("Nothing was deployed.");
    return;
  }

  const progress = spinner();
  progress.start("Preparing the Railway CLI");
  const rw = await railwayCli();
  // The project's directory, so Railway links it there.
  process.chdir(project.root);

  if (!(await attempt(() => railway(rw, ["whoami"])))) {
    progress.stop("Signing in to Railway");
    if (!process.stdin.isTTY) throw new UsageError("Sign in to Railway first with `railway login`, or set RAILWAY_API_TOKEN.");
    await railway(rw, ["login"], { inherit: true });
    progress.start("Signed in");
  }

  progress.message("Finding or creating the Railway project");
  let status = await attempt(() => railway(rw, ["status", "--json"]));
  if (!status) {
    await railway(rw, ["init", "--name", service, "--json"]);
    status = await attempt(() => railway(rw, ["status", "--json"]));
  }
  let existing: string[] = [];
  try {
    existing = serviceNames(JSON.parse(status ?? "{}"));
  } catch {
    // Unknown status format: create what is missing, as for a new project.
  }

  // A database URL the service already has without that database in the project points elsewhere
  // (an earlier --env-file): keep it. A new service has nothing to list yet; an existing one must
  // list its variables, or deploy could create Railway's database and switch the app over.
  const variables = await attempt(() => railway(rw, ["variable", "list", "--service", service, "--json"]));
  if (variables === null && existing.includes(service)) {
    throw new Error(`Railway didn't list the variables of the service "${service}", so deploy changed nothing. Run deploy again; if it keeps failing, check \`railway variable list --service ${service}\`.`);
  }
  const current = parseVariables(variables ?? "");
  const kept = databasesFor(project.modules, external)
    .filter((database) => current[databaseVariables[database]] && !existing.includes(railwayDatabases[database]))
    .map((database) => databaseVariables[database]);
  const hosted = databasesFor(project.modules, [...external, ...kept]);
  for (const database of hosted) {
    if (existing.includes(railwayDatabases[database])) continue;
    progress.message(`Adding ${railwayDatabases[database]}`);
    await railway(rw, ["add", "--database", database]);
  }
  if (!existing.includes(service)) {
    progress.message(`Adding the service "${service}"`);
    await railway(rw, ["add", "--service", service]);
  }

  progress.message("Creating the public domain");
  const listed = await attempt(() => railway(rw, ["domain", "list", "--service", service]));
  const domain =
    parseRailwayDomain(listed ?? "") ??
    parseRailwayDomain(await railway(rw, ["domain", "--service", service, "--port", String(appPort), "--json"]));
  if (!domain) throw new Error("Railway created no *.up.railway.app domain. Create one in the service's settings, then run deploy again.");
  const url = `https://${domain}`;

  progress.message("Setting the production variables");
  const plan = planVariables({ modules: project.modules, keys, url, existing: current, envFile, secret, databases: railwayReferences(hosted), clientAddress: clientAddresses.railway });
  for (const [key, value] of Object.entries(plan.set)) {
    if (current[key] === value) continue;
    await railway(rw, ["variable", "set", key, "--stdin", "--service", service, "--skip-deploys"], { input: value });
  }
  // The service's settings as code: .railway/railway.ts replaces railway.json, which Railway stops
  // reading on 2026-12-01. It needs Railway's TypeScript SDK, and applies before each release.
  const iacFiles = [railwayIacPath, ".railway/railway.py", ".railway/railway.go"];
  const changed: string[] = [];
  let hasIac = false;
  for (const file of iacFiles) if (await pathExists(join(project.root, file))) hasIac = true;
  if (!hasIac) {
    await mkdir(join(project.root, ".railway"), { recursive: true });
    await writeFile(join(project.root, railwayIacPath), railwayIacSource(service));
    changed.push(railwayIacPath);
  }
  if (await pathExists(join(project.root, railwayIacPath))) {
    const manifest = JSON.parse(await readFile(join(project.root, "package.json"), "utf8"));
    if (!manifest.devDependencies?.railway && !manifest.dependencies?.railway) {
      const pnpm = await resolvePnpm();
      if (!pnpm) throw new UsageError("pnpm was not found. Enable it with `corepack enable`, then run deploy again.");
      progress.stop("Adding Railway's TypeScript SDK (railway), which .railway/railway.ts imports");
      const [command, ...prefix] = pnpm;
      await run(command!, [...prefix, "add", "--save-dev", "--workspace-root", "railway"], project.root);
      changed.push("package.json", "pnpm-lock.yaml");
      progress.start("Applying .railway/railway.ts");
    }
  }
  progress.message(`Applying ${railwayIacPath}`);
  await railway(rw, ["config", "apply", "--yes"]);
  progress.stop(`Railway is ready: ${url}`);
  const unused = databasesFor(project.modules)
    .filter((database) => !hosted.includes(database) && existing.includes(railwayDatabases[database]))
    .map((database) => railwayDatabases[database]);
  if (unused.length) {
    log.info(`The app no longer uses Railway's ${unused.join(" and ")}: its URL comes from elsewhere now. Delete it in the dashboard (railway open) if you don't need its data.`);
  }
  if (changed.length) {
    log.info(
      `Commit ${changed.join(", ")}: Railway reads the service's settings from ${railwayIacPath} now. railway.json is no longer needed (Railway stops reading it on 2026-12-01).`,
    );
  }

  // Before the build, not after it: the app starts without these, but the features that use them
  // fail until they are set, and a build takes minutes.
  if (plan.unset.length) {
    log.warn(
      `Not set on the service: ${plan.unset.join(", ")}. The app starts without them, but the features that use them fail until they are set: pass --env-file, or run railway variable set KEY --stdin --service ${service}.`,
    );
    if (process.stdin.isTTY && !args.yes) {
      const proceed = await confirm({ message: "Deploy anyway?", initialValue: true });
      if (isCancel(proceed) || !proceed) {
        cancel("Nothing was deployed. Set them, then run deploy again: it reuses everything.");
        return;
      }
    }
  }

  // Start the deploy detached, then follow its status: `railway up` can return before the build
  // ends, and only Railway's final status says whether the release went live.
  const deploying = spinner();
  deploying.start("Uploading the project");
  const started = new Date();
  const upload = await railway(rw, ["up", "--service", service, "--detach"]);
  const id = parseDeploymentId(upload);
  let deployment = "QUEUED";
  const deadline = Date.now() + 45 * 60_000;
  while (!(finalStatuses as readonly string[]).includes(deployment)) {
    if (Date.now() > deadline) break;
    const elapsed = Math.round((Date.now() - started.getTime()) / 1000);
    deploying.message(`Railway: ${deployment.toLowerCase()} (${Math.floor(elapsed / 60)}m ${elapsed % 60}s; the first build takes several minutes)`);
    await new Promise((wait) => setTimeout(wait, 10_000));
    const list = await attempt(() => railway(rw, ["deployment", "list", "--service", service, "--json"]));
    deployment = deploymentStatus(list ?? "", id, started)?.status ?? deployment;
  }
  if (deployment !== "SUCCESS") {
    deploying.stop(`The deploy ended as ${deployment}`);
    throw new Error(
      [
        `Railway's deploy ended as ${deployment}. Read why with \`railway logs --build --service ${service}\` (the build) or \`railway logs --service ${service}\` (the app and its health check).`,
        "A build that ran out of time (DeadlineExceeded) usually passes on a second try. Otherwise fix the cause and run deploy again: it reuses what exists.",
      ].join("\n"),
    );
  }
  deploying.stop("Deployed: the migrations ran and /api/health answered");

  note(
    [
      `${bold("URL")}      ${url}`,
      `${bold("Service")}  ${service}`,
      ...(plan.unset.length ? ["", `${bold("Not set")}  ${plan.unset.join(", ")}`, dim("Set the ones your modules use: railway variable set KEY --stdin, or the dashboard.")] : []),
    ].join("\n"),
    "Deployed to Railway",
  );
  outro(
    [
      `${dim("Logs")}      railway logs --service ${service}`,
      `${dim("Dashboard")} railway open`,
      `${dim("Again")}     ${cli} deploy   ${dim("(reuses the project; --env-file to add variables)")}`,
    ].join("\n"),
  );
}
