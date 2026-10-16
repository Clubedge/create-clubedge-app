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
import {
  appPort,
  databaseVariables,
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

export async function deployProject(args: CliArgs): Promise<void> {
  const project = await readProject(process.cwd());
  const cli = await cliCommand(project);
  const platform = project.modules.deploy ?? "docker";
  if (args.preview) return await deployPreview(args, project, cli, await readDeployEnv(args, project));
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
    const preview = planVariables({ modules: project.modules, keys, url: "https://<service>.up.railway.app", existing: {}, envFile, secret: () => "<generated>" });
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
  const plan = planVariables({ modules: project.modules, keys, url, existing: current, envFile, secret, databases: railwayReferences(hosted) });
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
