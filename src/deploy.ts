// `deploy`: a guided first deploy to Railway, with Railway's own CLI. It creates (or reuses) the
// project, its databases, the app's service and domain, sets the production variables, and runs
// `railway up`; Railway then builds the image, runs the migrations, and checks /api/health.
import { cancel, confirm, isCancel, log, note, outro, spinner } from "@clack/prompts";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { UsageError, type CliArgs } from "./cli/args.js";
import { bold, dim } from "./cli/ui.js";
import {
  appPort,
  databasesFor,
  exampleKeys,
  parseEnvFile,
  parseRailwayDomain,
  parseVariables,
  planVariables,
  railwayDatabases,
  serviceName,
  serviceNames,
} from "./core/deploy.js";
import { readProject } from "./core/project.js";
import { cliCommand } from "./modify.js";
import { commandSucceeds } from "./utils/process.js";

const railwayTermsUrl = "https://railway.com/legal/terms";
const deployDocsUrl = "https://starter.clubedge.live/docs/starter/deploy";

// Package manager shims (npx.cmd, railway.cmd) need a shell on Windows. Every argument passed
// here is a plain word; values go through stdin, so the shell never sees them.
const useShell = process.platform === "win32";

/** The Railway CLI: the installed `railway`, or the npm package through npx. */
async function railwayCli(): Promise<string[]> {
  if (await commandSucceeds("railway", ["--version"])) return ["railway"];
  return ["npx", "--yes", "@railway/cli"];
}

interface RunOptions {
  /** Written to the command's stdin. */
  input?: string;
  /** Show the command's output and let it prompt (login, the deploy's build logs). */
  inherit?: boolean;
}

async function railway(cli: string[], args: string[], options: RunOptions = {}): Promise<string> {
  const [command, ...prefix] = cli;
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command!, [...prefix, ...args], {
      shell: useShell,
      stdio: options.inherit ? "inherit" : ["pipe", "pipe", "pipe"],
    });
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

async function agree(args: CliArgs, service: string, databases: string[]): Promise<boolean> {
  note(
    [
      "This deploys the project to Railway, in your Railway account:",
      "",
      `• A project with ${databases.map((db) => railwayDatabases[db as keyof typeof railwayDatabases]).join(" and ")}, and a service "${service}" with a public *.up.railway.app domain.`,
      "• The production variables Railway can provide; your provider keys come from --env-file.",
      "• Railway builds the Dockerfile, runs the migrations before the release, and checks /api/health.",
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
  if (platform !== "railway") {
    throw new UsageError(
      `deploy sets up Railway for now, and this project deploys with "${platform}". Switch with \`${cli} add deploy railway\`, or follow ${deployDocsUrl} for ${platform}.`,
    );
  }

  const service = serviceName(project.identity.packageName);
  const databases = databasesFor(project.modules);
  const keys = exampleKeys(await readFile(join(project.root, ".env.example"), "utf8").catch(() => ""));
  const envFile = args.envFile ? parseEnvFile(await readFile(resolve(process.cwd(), args.envFile), "utf8")) : {};
  const secret = () => randomBytes(32).toString("hex");

  if (args.dryRun) {
    const preview = planVariables({ modules: project.modules, keys, url: "https://<service>.up.railway.app", existing: {}, envFile, secret: () => "<generated>" });
    log.message(
      [
        `• Railway project "${service}" with ${databases.join(" and ")}, and the service "${service}"`,
        `• A *.up.railway.app domain for port ${appPort}`,
        `• Variables: ${Object.keys(preview.set).join(", ")}`,
        ...(preview.unset.length ? [`• Not set: ${preview.unset.join(", ")}`] : []),
        `• railway up: build, migrations, health check`,
      ].join("\n"),
    );
    outro("Dry run: nothing was created. Run again without --dry-run to deploy.");
    return;
  }

  if (!(await agree(args, service, databases))) {
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

  for (const database of databases) {
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
  const current = parseVariables((await attempt(() => railway(rw, ["variable", "list", "--service", service, "--json"]))) ?? "");
  const plan = planVariables({ modules: project.modules, keys, url, existing: current, envFile, secret });
  for (const [key, value] of Object.entries(plan.set)) {
    if (current[key] === value) continue;
    await railway(rw, ["variable", "set", key, "--stdin", "--service", service, "--skip-deploys"], { input: value });
  }
  progress.stop(`Railway is ready: ${url}`);

  log.step("Deploying with railway up (build logs follow; Railway runs the migrations, then checks /api/health)");
  try {
    await railway(rw, ["up", "--service", service], { inherit: true });
  } catch {
    throw new Error(
      `The deploy did not finish. Read the logs with \`railway logs --service ${service}\` (build: --build), fix the cause, and run deploy again: it reuses what exists.`,
    );
  }

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
