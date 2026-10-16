// `deploy` for Vercel: the platform only runs the app, so the database, Redis, storage, and email
// come from the env file. With Vercel's CLI and your login, it creates or reuses the project (built
// from apps/web, with the whole workspace uploaded), sets the production variables, runs
// `vercel deploy --prod`, and prints the public URL. The build checks the variables (check:env)
// and runs the migrations before it builds.
import { cancel, confirm, isCancel, log, note, outro, spinner } from "@clack/prompts";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { UsageError, type CliArgs } from "./cli/args.js";
import { bold, dim } from "./cli/ui.js";
import {
  appUrlKeys,
  exampleKeys,
  externalDatabaseUrls,
  ignoresEnvFiles,
  isLocalUrl,
  meetsMinimumCli,
  minimumVercelCli,
  parseVercelDeploymentUrl,
  parseVercelEnv,
  parseVercelProject,
  planVariables,
  railwayCliVersion,
  serviceName,
  vercelEnvBody,
  vercelIgnoreSource,
  vercelProductionUrl,
  vercelRootDirectory,
  type VercelProject,
} from "./core/deploy.js";
import type { Project } from "./core/project.js";
import { pathExists } from "./utils/fs.js";
import { openUrl } from "./utils/open.js";
import { spawnCommand } from "./utils/process.js";

const vercelCliUrl = "https://vercel.com/docs/cli";
const vercelPricingUrl = "https://vercel.com/pricing";
const windows = process.platform === "win32";

/** Vercel's CLI: an installed `vercel` new enough for `vercel api`, else the latest through npx. */
export interface VercelCli {
  command: string[];
}

interface RunOptions {
  /** Written to the command's stdin. */
  input?: string;
  /** "interactive": the command prompts (login). "stream": stdout is read, stderr shows progress. */
  mode?: "capture" | "interactive" | "stream";
}

/** Runs Vercel's CLI in the project's root; npm's .cmd shims need a shell on Windows. */
export async function vercel(cli: VercelCli, args: string[], cwd: string, options: RunOptions = {}): Promise<string> {
  const [command, ...prefix] = cli.command;
  const mode = options.mode ?? "capture";
  const stdio =
    mode === "interactive" ? "inherit" : mode === "stream" ? (["pipe", "pipe", "inherit"] as const) : (["pipe", "pipe", "pipe"] as const);
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawnCommand(command!, [...prefix, ...args], { cwd, stdio: stdio as never }, windows);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new Error(`vercel ${args[0]} failed${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : "."}`));
    });
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(options.input ?? "");
    }
  });
}

const attempt = async (run: () => Promise<string>) => run().catch(() => null);

export async function vercelCli(cwd: string): Promise<VercelCli> {
  for (const command of [["vercel"], ["npx", "--yes", "vercel@latest"]]) {
    const cli = { command };
    const version = railwayCliVersion((await attempt(() => vercel(cli, ["--version"], cwd))) ?? "");
    if (version && meetsMinimumCli(version, minimumVercelCli)) return cli;
  }
  throw new UsageError(
    `deploy to Vercel needs Vercel's CLI ${minimumVercelCli.join(".")} or newer. Install it with \`npm install -g vercel\` (${vercelCliUrl}), then run deploy again.`,
  );
}

/** The project `vercel link` recorded in .vercel/project.json, if any. */
export async function linkedProject(root: string): Promise<string | null> {
  try {
    const linked = JSON.parse(await readFile(join(root, ".vercel", "project.json"), "utf8")) as { projectId?: unknown };
    return typeof linked.projectId === "string" ? linked.projectId : null;
  } catch {
    return null;
  }
}

/** Writes .vercelignore when the project has none, so .env files never reach Vercel. */
async function ensureVercelIgnore(root: string): Promise<boolean> {
  const path = join(root, ".vercelignore");
  if (await pathExists(path)) {
    if (!ignoresEnvFiles(await readFile(path, "utf8"))) {
      log.warn("Your .vercelignore doesn't leave out .env files, so `vercel deploy` uploads them. Add `.env*` and `!.env.example` to it.");
    }
    return false;
  }
  const gitignore = await readFile(join(root, ".gitignore"), "utf8").catch(() => "");
  await writeFile(path, vercelIgnoreSource(gitignore));
  return true;
}

/** Variables a serverless host must not get: STORAGE_DIRECTORY stores files on a disk Vercel doesn't keep. */
const serverlessExcluded = ["STORAGE_DIRECTORY"];

export async function deployToVercel(args: CliArgs, project: Project, cli: string, fileValues: Record<string, string>): Promise<void> {
  const root = project.root;
  const skipped = serverlessExcluded.filter((key) => fileValues[key]);
  if (skipped.length) log.warn(`${skipped.join(", ")} stores files on the server's disk, which Vercel doesn't keep: not set. Files go to the storage bucket.`);
  const envFile = Object.fromEntries(Object.entries(fileValues).filter(([key]) => !serverlessExcluded.includes(key)));
  const keys = exampleKeys(await readFile(join(root, ".env.example"), "utf8").catch(() => "")).filter((key) => !serverlessExcluded.includes(key));
  if (!(await pathExists(join(root, vercelRootDirectory, "vercel.json")))) {
    throw new UsageError(`This project has no ${vercelRootDirectory}/vercel.json. Switch with \`${cli} add deploy vercel\`.`);
  }
  const name = serviceName(project.identity.packageName);
  const external = externalDatabaseUrls(project.modules, envFile);
  // A public URL of your own (a custom domain) wins; otherwise the one Vercel assigns.
  const ownUrl = appUrlKeys.map((key) => envFile[key]).find((value) => value && !isLocalUrl(value));
  const secret = () => randomBytes(32).toString("hex");

  if (!external.DATABASE_URL) {
    throw new UsageError(
      "Vercel only runs the app, so the database comes from your provider (Supabase, Neon, ...): put DATABASE_URL in .env.production (its pooled URL), or pass --env-file, then run deploy again.",
    );
  }

  if (args.dryRun) {
    const preview = planVariables({ modules: project.modules, keys, url: ownUrl ?? `https://${name}.vercel.app`, existing: {}, envFile, secret: () => "<generated>", databases: {} });
    const { NODE_ENV: _node, PORT: _port, ...values } = preview.set;
    log.message(
      [
        `• Vercel project "${name}", built from ${vercelRootDirectory} with the whole workspace uploaded`,
        `• Production variables: ${Object.keys(values).join(", ")}`,
        ...(preview.unset.length ? [`• Not set: ${preview.unset.join(", ")}`] : []),
        "• .vercelignore (when missing): what Git ignores, so .env files stay on this machine",
        "• vercel deploy --prod: check:env, the migrations, then the build",
      ].join("\n"),
    );
    outro("Dry run: nothing was created. Run again without --dry-run to deploy.");
    return;
  }

  note(
    [
      "This deploys the project to Vercel, in your Vercel account:",
      "",
      `• A project "${name}" that builds ${vercelRootDirectory}. Vercel only runs the app: the database${project.modules.cache === "redis" ? ", Redis," : ""} and the other services come from the env file.`,
      "• The production variables from the env file, the public URL, and a generated BETTER_AUTH_SECRET when the project uses Better Auth.",
      "• vercel deploy --prod: the build checks the variables (check:env), runs the migrations against DATABASE_URL, then builds.",
      "",
      `Vercel bills usage on your plan (${vercelPricingUrl}). Running deploy again reuses the project.`,
    ].join("\n"),
    "Deploy to Vercel",
  );
  if (!args.yes) {
    if (!process.stdin.isTTY) throw new UsageError("deploy creates a project in your Vercel account. Run it in a terminal to confirm, or pass --yes.");
    const answer = await confirm({ message: "Deploy?", initialValue: true });
    if (isCancel(answer) || !answer) {
      cancel("Nothing was deployed.");
      return;
    }
  }

  const progress = spinner();
  progress.start("Preparing Vercel's CLI");
  const vc = await vercelCli(root);
  if (!(await attempt(() => vercel(vc, ["whoami"], root)))) {
    progress.stop("Signing in to Vercel");
    if (!process.stdin.isTTY) throw new UsageError("Sign in to Vercel first with `vercel login`, or set VERCEL_TOKEN.");
    await vercel(vc, ["login"], root, { mode: "interactive" });
    progress.start("Signed in");
  }

  progress.message("Finding or creating the Vercel project");
  const linked = await linkedProject(root);
  let found: VercelProject | null = parseVercelProject((await attempt(() => vercel(vc, ["api", `/v9/projects/${linked ?? name}`], root))) ?? "");
  if (!found) {
    const created = await vercel(vc, ["api", "/v10/projects", "-X", "POST", "--input", "-"], root, {
      input: JSON.stringify({ name, rootDirectory: vercelRootDirectory }),
    });
    found = parseVercelProject(created);
    if (!found) throw new Error(`Vercel created no project "${name}". Create it in the dashboard with the Root Directory ${vercelRootDirectory}, then run deploy again.`);
  } else if (found.rootDirectory !== vercelRootDirectory) {
    progress.message(`Setting the project's Root Directory to ${vercelRootDirectory}`);
    await vercel(vc, ["api", `/v9/projects/${found.id}`, "-X", "PATCH", "--input", "-"], root, {
      input: JSON.stringify({ rootDirectory: vercelRootDirectory }),
    });
  }
  if (!linked) await vercel(vc, ["link", "--yes", "--project", found.name], root);
  const wroteIgnore = await ensureVercelIgnore(root);

  progress.message("Setting the production variables");
  const existing = parseVercelEnv((await attempt(() => vercel(vc, ["api", `/v10/projects/${found.id}/env`], root))) ?? "");
  const keptUrl = appUrlKeys.map((key) => existing[key]).find((value) => value && value !== "(set)" && !isLocalUrl(value));
  let url = ownUrl ?? keptUrl ?? `https://${found.name}.vercel.app`;
  const plan = planVariables({ modules: project.modules, keys, url, existing, envFile, secret, databases: {} });
  // Vercel sets NODE_ENV and the port itself.
  const { NODE_ENV: _node, PORT: _port, ...values } = plan.set;
  await vercel(vc, ["api", `/v10/projects/${found.id}/env?upsert=true`, "-X", "POST", "--input", "-"], root, {
    input: JSON.stringify(vercelEnvBody(values)),
  });
  progress.stop(`Vercel is ready: the project "${found.name}"`);
  if (wroteIgnore) log.info("Commit .vercelignore: it keeps .env files and build output out of `vercel deploy`.");

  if (plan.unset.length) {
    log.warn(`Not set: ${plan.unset.join(", ")}. The build stops at check:env when one of them is required; the others only turn features off.`);
    if (process.stdin.isTTY && !args.yes) {
      const proceed = await confirm({ message: "Deploy anyway?", initialValue: true });
      if (isCancel(proceed) || !proceed) {
        cancel("Nothing was deployed. Add them to .env.production, then run deploy again: it reuses the project.");
        return;
      }
    }
  }

  const deploy = async () => {
    log.step("Deploying with vercel deploy --prod (build logs follow)");
    try {
      const output = await vercel(vc, ["deploy", "--prod", "--yes", "--logs"], root, { mode: "stream" });
      const deployment = parseVercelDeploymentUrl(output);
      if (!deployment) throw new Error("no URL");
      return deployment;
    } catch {
      throw new Error(
        "The deploy did not finish. The build log above says why (check:env names missing variables); `vercel inspect --logs <url>` shows it again. Fix the cause and run deploy again: it reuses the project.",
      );
    }
  };

  const deployment = await deploy();
  const details = await attempt(() => vercel(vc, ["api", `/v13/deployments/${deployment.replace(/^https:\/\//, "")}`], root));
  const assigned = vercelProductionUrl(details ?? "", deployment);
  // Next.js compiles the public URL into the build: when Vercel picked another name, set it and build again.
  if (!ownUrl && assigned && assigned !== url) {
    log.info(`Vercel named the app ${assigned}. Setting it as the public URL and deploying again, since the build compiles it in.`);
    url = assigned;
    await vercel(vc, ["api", `/v10/projects/${found.id}/env?upsert=true`, "-X", "POST", "--input", "-"], root, {
      input: JSON.stringify(vercelEnvBody(Object.fromEntries(appUrlKeys.map((key) => [key, url])))),
    });
    await deploy();
  }

  note(
    [
      `${bold("URL")}      ${url}`,
      `${bold("Project")}  ${found.name}`,
      ...(plan.unset.length ? ["", `${bold("Not set")}  ${plan.unset.join(", ")}`] : []),
    ].join("\n"),
    "Deployed to Vercel",
  );
  if (args.open && process.stdin.isTTY && !args.yes && (await openUrl(url))) log.info("Opened the app in your browser.");
  outro(
    [
      `${dim("Logs")}      vercel logs ${url}`,
      `${dim("Dashboard")} vercel open`,
      `${dim("Again")}     ${cli} deploy   ${dim("(reuses the project; .env.production adds variables)")}`,
    ].join("\n"),
  );
}
