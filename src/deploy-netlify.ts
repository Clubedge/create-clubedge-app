// `deploy` for Netlify (experimental): the platform only runs the app, so the database, Redis,
// storage, and email come from the env file. With Netlify's CLI and your login, it creates or
// reuses the site (its base directory apps/web, where netlify.toml is), links the project to it,
// imports the production variables, and runs `netlify deploy --build --prod`. The build runs on
// this machine with the site's variables: check:env, the migrations, then Netlify's build.
import { cancel, confirm, isCancel, log, note, outro, spinner } from "@clack/prompts";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { UsageError, type CliArgs } from "./cli/args.js";
import { bold, dim } from "./cli/ui.js";
import {
  appUrlKeys,
  exampleKeys,
  externalDatabaseUrls,
  isLocalUrl,
  netlifyBaseDirectory,
  netlifyEnvFile,
  netlifySiteName,
  parseNetlifyAccounts,
  parseNetlifyDeploy,
  parseNetlifySite,
  planVariables,
  serviceName,
  type NetlifySite,
} from "./core/deploy.js";
import type { Project } from "./core/project.js";
import { pathExists } from "./utils/fs.js";
import { openUrl } from "./utils/open.js";
import { spawnCommand } from "./utils/process.js";

const netlifyCliUrl = "https://docs.netlify.com/cli/get-started/";
const netlifyPricingUrl = "https://www.netlify.com/pricing/";
const windows = process.platform === "win32";

/** Netlify's CLI: the installed `netlify`, else the latest through npx. */
interface NetlifyCli {
  command: string[];
}

interface RunOptions {
  /** "interactive": the command prompts (login). "stream": stdout is read, stderr shows progress. */
  mode?: "capture" | "interactive" | "stream";
}

/** Runs Netlify's CLI in the project's root; npm's .cmd shims need a shell on Windows. */
async function netlify(cli: NetlifyCli, args: string[], cwd: string, options: RunOptions = {}): Promise<string> {
  const [command, ...prefix] = cli.command;
  const mode = options.mode ?? "capture";
  const stdio =
    mode === "interactive" ? "inherit" : mode === "stream" ? (["ignore", "pipe", "inherit"] as const) : (["ignore", "pipe", "pipe"] as const);
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawnCommand(command!, [...prefix, ...args], { cwd, stdio: stdio as never }, windows);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new Error(`netlify ${args[0]} failed${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : "."}`));
    });
  });
}

const attempt = async (run: () => Promise<string>) => run().catch(() => null);

async function netlifyCli(cwd: string): Promise<NetlifyCli> {
  for (const command of [["netlify"], ["npx", "--yes", "netlify-cli@latest"]]) {
    const cli = { command };
    if (await attempt(() => netlify(cli, ["--version"], cwd))) return cli;
  }
  throw new UsageError(`deploy to Netlify needs Netlify's CLI. Install it with \`npm install -g netlify-cli\` (${netlifyCliUrl}), then run deploy again.`);
}

/** `netlify api <method>` with its parameters, parsed as JSON. */
async function api(cli: NetlifyCli, method: string, data: Record<string, unknown> | null, cwd: string): Promise<string> {
  return await netlify(cli, ["api", method, ...(data ? ["--data", JSON.stringify(data)] : [])], cwd);
}

/** The site `netlify link` recorded in .netlify/state.json, if any. */
async function linkedSite(root: string): Promise<string | null> {
  try {
    const state = JSON.parse(await readFile(join(root, ".netlify", "state.json"), "utf8")) as { siteId?: unknown };
    return typeof state.siteId === "string" ? state.siteId : null;
  } catch {
    return null;
  }
}

/** The name of the app's package, which `--filter` selects in the workspace. */
async function appPackage(root: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(join(root, netlifyBaseDirectory, "package.json"), "utf8")) as { name?: unknown };
    return typeof manifest.name === "string" ? manifest.name : null;
  } catch {
    return null;
  }
}

/** Variables a serverless host must not get: STORAGE_DIRECTORY stores files on a disk Netlify doesn't keep. */
const serverlessExcluded = ["STORAGE_DIRECTORY"];

export async function deployToNetlify(args: CliArgs, project: Project, cli: string, fileValues: Record<string, string>): Promise<void> {
  const root = project.root;
  const skipped = serverlessExcluded.filter((key) => fileValues[key]);
  if (skipped.length) log.warn(`${skipped.join(", ")} stores files on the server's disk, which Netlify doesn't keep: not set. Files go to the storage bucket.`);
  const envFile = Object.fromEntries(Object.entries(fileValues).filter(([key]) => !serverlessExcluded.includes(key)));
  const keys = exampleKeys(await readFile(join(root, ".env.example"), "utf8").catch(() => "")).filter((key) => !serverlessExcluded.includes(key));
  if (!(await pathExists(join(root, netlifyBaseDirectory, "netlify.toml")))) {
    throw new UsageError(`This project has no ${netlifyBaseDirectory}/netlify.toml. Switch with \`${cli} add deploy netlify\`.`);
  }
  const name = netlifySiteName(serviceName(project.identity.packageName));
  const external = externalDatabaseUrls(project.modules, envFile);
  // A public URL of your own (a custom domain) wins; otherwise the site's *.netlify.app URL.
  const ownUrl = appUrlKeys.map((key) => envFile[key]).find((value) => value && !isLocalUrl(value));
  const secret = () => randomBytes(32).toString("hex");

  if (!external.DATABASE_URL) {
    throw new UsageError(
      "Netlify only runs the app, so the database comes from your provider (Supabase, Neon, ...): put DATABASE_URL in .env.production (its pooled URL), or pass --env-file, then run deploy again.",
    );
  }

  if (args.dryRun) {
    const preview = planVariables({ modules: project.modules, keys, url: ownUrl ?? `https://${name}.netlify.app`, existing: {}, envFile, secret: () => "<generated>", databases: {} });
    const { NODE_ENV: _node, PORT: _port, ...values } = preview.set;
    log.message(
      [
        `• Netlify site "${name}", built from ${netlifyBaseDirectory}, linked in .netlify/state.json`,
        `• Variables: ${Object.keys(values).join(", ")}`,
        ...(preview.unset.length ? [`• Not set: ${preview.unset.join(", ")}`] : []),
        "• netlify deploy --build --prod, on this machine: check:env, the migrations, then the build",
      ].join("\n"),
    );
    outro("Dry run: nothing was created. Run again without --dry-run to deploy.");
    return;
  }

  note(
    [
      "This deploys the project to Netlify, in your Netlify account:",
      "",
      `• A site "${name}" that builds ${netlifyBaseDirectory}. Netlify only runs the app: the database${project.modules.cache === "redis" ? ", Redis," : ""} and the other services come from the env file.`,
      "• The production variables from the env file, the public URL, and a generated BETTER_AUTH_SECRET when the project uses Better Auth.",
      "• netlify deploy --build --prod builds on this machine with the site's variables: check:env, the migrations against DATABASE_URL, then the build, which it uploads.",
      "",
      `Netlify bills usage on your plan (${netlifyPricingUrl}). Running deploy again reuses the site.`,
    ].join("\n"),
    "Deploy to Netlify",
  );
  if (!args.yes) {
    if (!process.stdin.isTTY) throw new UsageError("deploy creates a site in your Netlify account. Run it in a terminal to confirm, or pass --yes.");
    const answer = await confirm({ message: "Deploy?", initialValue: true });
    if (isCancel(answer) || !answer) {
      cancel("Nothing was deployed.");
      return;
    }
  }

  const progress = spinner();
  progress.start("Preparing Netlify's CLI");
  const nl = await netlifyCli(root);
  // `netlify login` returns at once when you are signed in; otherwise it opens the browser.
  if (!process.env.NETLIFY_AUTH_TOKEN) {
    progress.stop("Signing in to Netlify");
    if (!process.stdin.isTTY && !(await attempt(() => api(nl, "getCurrentUser", null, root)))) {
      throw new UsageError("Sign in to Netlify first with `netlify login`, or set NETLIFY_AUTH_TOKEN.");
    }
    await netlify(nl, ["login"], root, { mode: "interactive" });
    progress.start("Signed in");
  }

  progress.message("Finding or creating the Netlify site");
  const linked = await linkedSite(root);
  const lookup = async (id: string) => parseNetlifySite((await attempt(() => api(nl, "getSite", { site_id: id }, root))) ?? "");
  let site: NetlifySite | null = linked ? await lookup(linked) : await lookup(`${name}.netlify.app`);
  if (!site) {
    const [team] = parseNetlifyAccounts((await attempt(() => api(nl, "listAccountsForUser", null, root))) ?? "");
    if (!team) throw new Error("Netlify listed no team for your account. Check `netlify status`, then run deploy again.");
    // Site names are global on Netlify: when the package's is taken, add a short suffix.
    for (const candidate of [name, `${name.slice(0, 58)}-${randomBytes(2).toString("hex")}`]) {
      const body = { name: candidate, build_settings: { base: netlifyBaseDirectory } };
      site = parseNetlifySite((await attempt(() => api(nl, "createSiteInTeam", { account_slug: team, body }, root))) ?? "");
      if (site) break;
    }
    if (!site) throw new Error(`Netlify created no site "${name}". Create it in the dashboard with the base directory ${netlifyBaseDirectory}, link it with \`netlify link\`, then run deploy again.`);
  } else if (site.base !== netlifyBaseDirectory) {
    progress.message(`Setting the site's base directory to ${netlifyBaseDirectory}`);
    await api(nl, "updateSite", { site_id: site.id, body: { build_settings: { base: netlifyBaseDirectory } } }, root);
  }
  if (linked !== site.id) await netlify(nl, ["link", "--id", site.id], root);

  progress.message("Setting the production variables");
  const existing = await attempt(() => netlify(nl, ["env:list", "--json", "--context", "production"], root));
  let current: Record<string, string> = {};
  try {
    current = JSON.parse(existing ?? "{}") as Record<string, string>;
  } catch {
    // Unknown output: every variable counts as unset, and the import sets them again.
  }
  const url = ownUrl ?? site.url;
  const plan = planVariables({ modules: project.modules, keys, url, existing: current, envFile, secret, databases: {} });
  // Netlify sets NODE_ENV and the port itself.
  const { NODE_ENV: _node, PORT: _port, ...values } = plan.set;
  // env:import reads a file: the values never appear on a command line. It stays private and goes away after.
  const directory = await mkdtemp(join(tmpdir(), "clubedge-netlify-"));
  try {
    const file = join(directory, "production.env");
    await writeFile(file, netlifyEnvFile(values), { mode: 0o600 });
    await netlify(nl, ["env:import", file], root);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  progress.stop(`Netlify is ready: the site "${site.name}"`);

  if (plan.unset.length) {
    log.warn(`Not set: ${plan.unset.join(", ")}. The build stops at check:env when one of them is required; the others only turn features off.`);
    if (process.stdin.isTTY && !args.yes) {
      const proceed = await confirm({ message: "Deploy anyway?", initialValue: true });
      if (isCancel(proceed) || !proceed) {
        cancel("Nothing was deployed. Add them to .env.production, then run deploy again: it reuses the site.");
        return;
      }
    }
  }

  log.step("Deploying with netlify deploy --build --prod (build logs follow)");
  const filter = await appPackage(root);
  let deployed: string | null = null;
  try {
    const output = await netlify(nl, ["deploy", "--build", "--prod", "--json", ...(filter ? ["--filter", filter] : [])], root, { mode: "stream" });
    deployed = parseNetlifyDeploy(output);
  } catch {
    throw new Error(
      "The deploy did not finish. The build log above says why (check:env names missing variables). Fix the cause and run deploy again: it reuses the site.",
    );
  }
  if (!deployed) log.warn("Netlify printed no deploy URL. Check the site's deploys with `netlify open`.");

  note(
    [
      `${bold("URL")}      ${url}`,
      `${bold("Site")}     ${site.name}`,
      ...(plan.unset.length ? ["", `${bold("Not set")}  ${plan.unset.join(", ")}`] : []),
    ].join("\n"),
    "Deployed to Netlify",
  );
  if (args.open && process.stdin.isTTY && !args.yes && (await openUrl(url))) log.info("Opened the app in your browser.");
  outro(
    [
      `${dim("Logs")}      netlify logs`,
      `${dim("Dashboard")} netlify open`,
      `${dim("Again")}     ${cli} deploy   ${dim("(reuses the site; .env.production adds variables)")}`,
    ].join("\n"),
  );
}
