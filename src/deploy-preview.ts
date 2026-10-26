// `deploy --preview`: a deployment of the current Git branch next to production, on Vercel (a
// preview deployment) or Railway (an environment copied from production). With NEON_API_KEY and
// NEON_PROJECT_ID, it gets its own Neon branch, a copy of the production database made in
// seconds, with this branch's migrations applied; .github/workflows/preview.yml does the same for
// each pull request.
import { cancel, confirm, isCancel, log, note, outro, spinner } from "@clack/prompts";
import process from "node:process";
import { UsageError, type CliArgs } from "./cli/args.js";
import { bold, dim } from "./cli/ui.js";
import {
  appPort,
  clientAddresses,
  clientAddressVariables,
  deploymentStatus,
  externalDatabaseUrls,
  finalStatuses,
  parseDeploymentId,
  parseRailwayDomain,
  parseVercelDeploymentUrl,
  railwayEnvironmentNames,
  serviceName,
  vercelPreviewEnvBody,
} from "./core/deploy.js";
import { ensureNeonBranch, neonRoleAndDatabase, previewBranchName, type NeonBranch } from "./core/neon.js";
import type { Project } from "./core/project.js";
import { railway, railwayCli } from "./deploy.js";
import { linkedProject, vercel, vercelCli } from "./deploy-vercel.js";
import { resolvePnpm } from "./steps/install.js";
import { openUrl } from "./utils/open.js";
import { runCapture, spawnCommand } from "./utils/process.js";

const neonApiKeysUrl = "https://neon.com/docs/manage/api-keys";

/** A name for previews of a Git branch: lowercase letters, digits, and dashes. */
export function previewName(gitBranch: string): string {
  return previewBranchName(gitBranch).replace(/^preview\//, "preview-");
}

const attempt = async (run: () => Promise<string>) => run().catch(() => null);

/** Runs the migrations here against the preview's branch: its direct URL, as the migrator prefers. */
async function migrate(root: string, branch: NeonBranch) {
  const pnpm = await resolvePnpm();
  if (!pnpm) throw new UsageError("pnpm was not found. Enable it with `corepack enable`, then run deploy again.");
  const [command, ...prefix] = pnpm;
  const env = { ...process.env, DATABASE_URL: branch.url, DATABASE_URL_DIRECT: branch.directUrl };
  // A new branch's compute can take a few seconds to accept connections.
  for (let tries = 1; ; tries++) {
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawnCommand(command!, [...prefix, "db:migrate"], { cwd: root, env, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (exit) => resolve(exit ?? 1));
    });
    if (code === 0) return;
    if (tries >= 3) throw new Error("The migrations failed on the preview's Neon branch; the output above says why.");
    await new Promise((wait) => setTimeout(wait, 5_000));
  }
}

export async function deployPreview(args: CliArgs, project: Project, cli: string, envFile: Record<string, string>): Promise<void> {
  // A preview is one service named after the package; a frontend and an API are two, and an API
  // without a web app is named after its service.
  const separate = Object.values(project.services).filter(({ role }) => role !== "fullstack");
  if (separate.length === 1) {
    const service = serviceName(`${serviceName(project.identity.packageName)}-${separate[0]!.id}`);
    throw new UsageError(
      `deploy --preview works with a web app for now, and this project runs only its API (${service}). Deploy production with \`${cli} deploy\`; for a preview on Railway, copy production with \`railway environment new <name> --duplicate production\`, then run \`railway up --service ${service} --environment <name>\`.`,
    );
  }
  if (separate.length > 1) {
    const base = serviceName(project.identity.packageName);
    const services = separate.map(({ id }) => serviceName(`${base}-${id}`)).join(" and ");
    throw new UsageError(
      `deploy --preview works with a single app for now, and this project runs its frontend and API as separate services (${services}). Deploy production with \`${cli} deploy\`; for a preview on Railway, copy production with \`railway environment new <name> --duplicate production\`, then run \`railway up --service <service> --environment <name>\` for each service.`,
    );
  }
  const platform = project.modules.deploy ?? "docker";
  if (platform !== "vercel" && platform !== "railway") {
    throw new UsageError(`deploy --preview works with Vercel and Railway, and this project deploys with "${platform}". Its pull requests still get a Neon branch from .github/workflows/preview.yml.`);
  }
  const gitBranch = await runCapture("git", ["branch", "--show-current"], project.root).catch(() => "");
  if (!gitBranch) throw new UsageError("deploy --preview names the preview after the current Git branch: check one out first.");
  const name = previewName(gitBranch);

  // Neon's API key and project: from the shell, else from the env file.
  const apiKey = process.env.NEON_API_KEY || envFile.NEON_API_KEY;
  const projectId = process.env.NEON_PROJECT_ID || envFile.NEON_PROJECT_ID;
  const branchName = previewBranchName(gitBranch);
  const external = externalDatabaseUrls(project.modules, envFile);
  if (!apiKey || !projectId) {
    // Copied from production, a Railway environment would keep a database URL from elsewhere: production's data.
    if (platform === "railway" && external.DATABASE_URL) {
      throw new UsageError(
        `Production's DATABASE_URL comes from outside Railway, so a copied environment would use production's data. Set NEON_API_KEY (${neonApiKeysUrl}) and NEON_PROJECT_ID, in the shell or the env file, so the preview gets its own Neon branch.`,
      );
    }
    log.info(
      platform === "vercel"
        ? "Without NEON_API_KEY and NEON_PROJECT_ID, the preview uses the DATABASE_URL of the Vercel project's Preview variables."
        : "Without NEON_API_KEY and NEON_PROJECT_ID, the preview environment gets its own copy of Railway's Postgres, empty, migrated before the release.",
    );
  }
  const neon = apiKey && projectId ? { apiKey, projectId, name: branchName, ...neonRoleAndDatabase(external.DATABASE_URL) } : null;

  const steps = [
    ...(neon ? [`Neon branch "${branchName}" of project ${projectId} (created, or reused from an earlier preview), with this branch's migrations`] : []),
    platform === "vercel"
      ? `A Vercel preview deployment of "${gitBranch}"${neon ? ", with DATABASE_URL and DATABASE_URL_DIRECT pointing at the branch" : ""}`
      : `A Railway environment "${name}", copied from production, with its own domain${neon ? " and the branch as its database" : ""}; railway up deploys "${gitBranch}" to it`,
  ];
  if (args.dryRun) {
    log.message(steps.map((step) => `• ${step}`).join("\n"));
    outro("Dry run: nothing was created. Run again without --dry-run to deploy the preview.");
    return;
  }
  note([...steps.map((step) => `• ${step}`), "", "Production is not changed. The platforms bill previews like any deployment."].join("\n"), "Deploy a preview");
  if (!args.yes) {
    if (!process.stdin.isTTY) throw new UsageError("deploy --preview creates resources in your accounts. Run it in a terminal to confirm, or pass --yes.");
    const answer = await confirm({ message: "Deploy the preview?", initialValue: true });
    if (isCancel(answer) || !answer) {
      cancel("Nothing was deployed.");
      return;
    }
  }

  const progress = spinner();
  let branch: NeonBranch | null = null;
  if (neon) {
    progress.start(`Preparing the Neon branch "${branchName}"`);
    try {
      branch = await ensureNeonBranch(neon);
    } catch (error) {
      progress.stop("Neon gave no branch");
      throw error;
    }
    progress.stop(branch.created ? `Created the Neon branch "${branchName}"` : `Reusing the Neon branch "${branchName}"`);
    log.step("Applying this branch's migrations to it");
    await migrate(project.root, branch);
  }

  // Where the app finds the client's address, as deploy sets it for production: a copied Railway
  // environment may come from an earlier deploy, and Vercel's previews don't get production's variables.
  const address = clientAddressVariables(clientAddresses[platform], envFile);
  const url =
    platform === "vercel" ? await toVercel(project, cli, gitBranch, branch, address) : await toRailway(project, cli, name, branch, address);
  note(
    [`${bold("URL")}       ${url}`, `${bold("Git")}       ${gitBranch}`, ...(branch ? [`${bold("Database")}  Neon branch ${branch.name}`] : [])].join("\n"),
    "Preview deployed",
  );
  if (args.open && process.stdin.isTTY && !args.yes && (await openUrl(url))) log.info("Opened the preview in your browser.");
  outro(
    [
      `${dim("Again")}     ${cli} deploy --preview   ${dim("(reuses the branch and the environment)")}`,
      ...(branch ? [`${dim("Clean up")}  delete the branch ${branch.name} in the Neon console${platform === "railway" ? `, and: railway environment delete ${name} --yes` : ""}`] : []),
      ...(!branch && platform === "railway" ? [`${dim("Clean up")}  railway environment delete ${name} --yes`] : []),
    ].join("\n"),
  );
}

async function toVercel(project: Project, cli: string, gitBranch: string, branch: NeonBranch | null, address: Record<string, string>): Promise<string> {
  const root = project.root;
  const progress = spinner();
  progress.start("Preparing Vercel's CLI");
  const vc = await vercelCli(root);
  if (!(await attempt(() => vercel(vc, ["whoami"], root)))) {
    progress.stop("Signing in to Vercel");
    if (!process.stdin.isTTY) throw new UsageError("Sign in to Vercel first with `vercel login`, or set VERCEL_TOKEN.");
    await vercel(vc, ["login"], root, { mode: "interactive" });
    progress.start("Signed in");
  }
  const projectId = await linkedProject(root);
  if (!projectId) {
    progress.stop("No Vercel project");
    throw new UsageError(`This project isn't linked to Vercel yet. Run \`${cli} deploy\` once for production, then deploy previews.`);
  }
  // The branch's URLs as Preview variables of this Git branch, sent on stdin: the build (whose
  // migrations then find nothing left to apply) and later redeploys from the dashboard use them.
  if (branch) {
    progress.message(`Setting the Preview variables of "${gitBranch}"`);
    const values = { DATABASE_URL: branch.url, DATABASE_URL_DIRECT: branch.directUrl };
    const scoped = await attempt(() =>
      vercel(vc, ["api", `/v10/projects/${projectId}/env?upsert=true`, "-X", "POST", "--input", "-"], root, {
        input: JSON.stringify(vercelPreviewEnvBody(values, gitBranch)),
      }),
    );
    // Without them the preview would build against the project's Preview DATABASE_URL, and passing
    // the URLs as deploy flags would put the password on the command line: stop instead.
    if (scoped === null) {
      progress.stop("Vercel refused the Preview variables");
      throw new UsageError(
        `Vercel didn't accept Preview variables for the Git branch "${gitBranch}". Branch variables need the project connected to its Git repository: in Vercel, open the project's Settings, then Git, connect the repository, and run deploy --preview again. Nothing was deployed; the Neon branch ${branch.name} is ready.`,
      );
    }
  }
  progress.stop("Vercel is ready");
  log.step("Deploying with vercel deploy (build logs follow)");
  let output: string;
  // They hold no secret, so they go on the deployment's command line.
  const env = Object.entries(address).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  try {
    output = await vercel(vc, ["deploy", "--yes", "--logs", ...env], root, { mode: "stream" });
  } catch {
    throw new Error("The preview did not deploy. The build log above says why; fix the cause and run deploy --preview again.");
  }
  const url = parseVercelDeploymentUrl(output);
  if (!url) throw new Error("Vercel printed no deployment URL. Find the preview with `vercel ls`.");
  return url;
}

async function toRailway(project: Project, cli: string, environment: string, branch: NeonBranch | null, address: Record<string, string>): Promise<string> {
  const service = serviceName(project.identity.packageName);
  const progress = spinner();
  progress.start("Preparing the Railway CLI");
  const rw = await railwayCli();
  process.chdir(project.root);
  if (!(await attempt(() => railway(rw, ["whoami"])))) {
    progress.stop("Not signed in");
    throw new UsageError("Sign in to Railway first with `railway login`, or set RAILWAY_API_TOKEN.");
  }
  if (!(await attempt(() => railway(rw, ["status", "--json"])))) {
    progress.stop("No Railway project");
    throw new UsageError(`This project isn't linked to Railway yet. Run \`${cli} deploy\` once for production, then deploy previews.`);
  }
  const environments = railwayEnvironmentNames(await railway(rw, ["environment", "list", "--json"]));
  if (!environments.includes(environment)) {
    progress.message(`Creating the environment "${environment}" from production`);
    await railway(rw, ["environment", "new", environment, "--duplicate", "production", "--json"]);
  }
  const scope = ["--service", service, "--environment", environment];
  if (branch) {
    progress.message("Pointing the environment at the Neon branch");
    for (const [key, value] of [["DATABASE_URL", branch.url], ["DATABASE_URL_DIRECT", branch.directUrl]] as const) {
      await railway(rw, ["variable", "set", key, "--stdin", ...scope, "--skip-deploys"], { input: value });
    }
  }
  progress.message("Creating the preview's domain");
  const domain =
    parseRailwayDomain((await attempt(() => railway(rw, ["domain", "list", ...scope]))) ?? "") ??
    parseRailwayDomain(await railway(rw, ["domain", ...scope, "--port", String(appPort), "--json"]));
  if (!domain) throw new Error(`Railway created no domain for the environment "${environment}". Create one in its settings, then run deploy --preview again.`);
  const url = `https://${domain}`;
  for (const key of ["APP_URL", "NEXT_PUBLIC_APP_URL"]) {
    await railway(rw, ["variable", "set", key, "--stdin", ...scope, "--skip-deploys"], { input: url });
  }
  // The domain sends traffic to appPort; without PORT, Railway assigns its own and the app answers 502.
  await railway(rw, ["variable", "set", "PORT", "--stdin", ...scope, "--skip-deploys"], { input: String(appPort) });
  for (const [key, value] of Object.entries(address)) {
    await railway(rw, ["variable", "set", key, "--stdin", ...scope, "--skip-deploys"], { input: value });
  }
  progress.message("Uploading the project");
  const started = new Date();
  const id = parseDeploymentId(await railway(rw, ["up", ...scope, "--detach"]));
  let status = "QUEUED";
  const deadline = Date.now() + 45 * 60_000;
  while (!(finalStatuses as readonly string[]).includes(status) && Date.now() < deadline) {
    const elapsed = Math.round((Date.now() - started.getTime()) / 1000);
    progress.message(`Railway: ${status.toLowerCase()} (${Math.floor(elapsed / 60)}m ${elapsed % 60}s)`);
    await new Promise((wait) => setTimeout(wait, 10_000));
    const list = await attempt(() => railway(rw, ["deployment", "list", ...scope, "--json"]));
    status = deploymentStatus(list ?? "", id, started)?.status ?? status;
  }
  if (status !== "SUCCESS") {
    progress.stop(`The preview ended as ${status}`);
    throw new Error(`Railway's preview deploy ended as ${status}. Read why with \`railway logs --build ${scope.join(" ")}\`.`);
  }
  progress.stop("Preview deployed: the migrations ran and /api/health answered");
  return url;
}
