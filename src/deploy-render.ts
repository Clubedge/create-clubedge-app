// `deploy` for Render (experimental): Render builds the Dockerfile from the project's Git repository,
// so the branch must be pushed. With an API key (RENDER_API_KEY, or pasted when deploy asks), it
// creates or reuses a Docker web service that runs the migrations before each release and checks
// /api/health, as render.yaml does, sets the production variables, deploys, and waits until the
// release is live. Render has no database here: DATABASE_URL comes from the env file.
import { cancel, confirm, isCancel, log, note, outro, password, select, spinner } from "@clack/prompts";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { UsageError, type CliArgs } from "./cli/args.js";
import { bold, dim } from "./cli/ui.js";
import {
  appUrlKeys,
  clientAddresses,
  exampleKeys,
  externalDatabaseUrls,
  isLocalUrl,
  parseRenderEnv,
  parseRenderOwners,
  parseRenderService,
  planVariables,
  renderApiUrl,
  renderFinalStatuses,
  renderRepoUrl,
  renderServiceBody,
  serviceName,
  type RenderService,
} from "./core/deploy.js";
import type { Project } from "./core/project.js";
import { openUrl } from "./utils/open.js";
import { runCapture } from "./utils/process.js";

const renderKeysUrl = "https://dashboard.render.com/u/settings#api-keys";
const renderPricingUrl = "https://render.com/pricing";

/** Calls Render's API; an error names the request and Render's message. */
async function render<T = unknown>(key: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${renderApiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text.trim();
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? message;
    } catch {
      // Not JSON: Render's text as it is.
    }
    throw new Error(`Render's API answered ${response.status} to ${method} ${path.replace(/\?.*$/, "")}${message ? `: ${message}` : "."}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/** The Git remote and branch Render builds, after checking the branch is pushed. */
async function gitSource(root: string): Promise<{ repo: string; branch: string }> {
  const git = (...argv: string[]) => runCapture("git", argv, root);
  const remote = await git("remote", "get-url", "origin").catch(() => "");
  const repo = renderRepoUrl(remote);
  if (!repo) {
    throw new UsageError(
      "Render builds from your Git repository: push this project to GitHub, GitLab, or Bitbucket as `origin`, then run deploy again.",
    );
  }
  const branch = await git("rev-parse", "--abbrev-ref", "HEAD").catch(() => "");
  if (!branch || branch === "HEAD") {
    throw new UsageError("Render builds a branch of your Git repository: commit the project on a branch and push it, then run deploy again.");
  }
  const ahead = await git("rev-list", "--count", `origin/${branch}..HEAD`).catch(() => null);
  if (ahead === null) throw new UsageError(`Render builds the branch ${branch} from ${repo}, which isn't pushed yet. Run \`git push -u origin ${branch}\`, then deploy again.`);
  if (ahead !== "0") log.warn(`${ahead} commit(s) on ${branch} aren't pushed: Render builds what ${repo} has. Run \`git push\` to include them.`);
  return { repo, branch };
}

/** The API key: RENDER_API_KEY, else pasted from the dashboard's API keys page. */
async function apiKey(): Promise<string> {
  if (process.env.RENDER_API_KEY) return process.env.RENDER_API_KEY;
  if (!process.stdin.isTTY) throw new UsageError(`Set RENDER_API_KEY to a Render API key (${renderKeysUrl}), then run deploy again.`);
  log.info(`Render signs deploy in with an API key. Create one on the page that opens (${renderKeysUrl}) and paste it here.`);
  await openUrl(renderKeysUrl);
  const key = await password({ message: "Render API key", validate: (value) => (value?.trim() ? undefined : "Paste the key from Render's dashboard.") });
  if (isCancel(key)) throw new UsageError("Nothing was deployed.");
  log.info("Set RENDER_API_KEY to it, and deploy won't ask next time.");
  return key.trim();
}

/** The workspace for the service: the only one, or the one you pick. */
async function workspace(key: string, args: CliArgs): Promise<string> {
  const owners = parseRenderOwners(await render(key, "GET", "/owners?limit=100"));
  if (!owners.length) throw new Error("Render listed no workspace for this API key.");
  if (owners.length === 1 || args.yes || !process.stdin.isTTY) return owners[0]!.id;
  const picked = await select({ message: "Render workspace", options: owners.map((owner) => ({ value: owner.id, label: owner.name })) });
  if (isCancel(picked)) throw new UsageError("Nothing was deployed.");
  return picked;
}

export async function deployToRender(args: CliArgs, project: Project, cli: string, envFile: Record<string, string>): Promise<void> {
  const root = project.root;
  const keys = exampleKeys(await readFile(join(root, ".env.example"), "utf8").catch(() => ""));
  const name = serviceName(project.identity.packageName);
  const external = externalDatabaseUrls(project.modules, envFile);
  // A public URL of your own (a custom domain) wins; otherwise the service's *.onrender.com URL.
  const ownUrl = appUrlKeys.map((key) => envFile[key]).find((value) => value && !isLocalUrl(value));
  const secret = () => randomBytes(32).toString("hex");

  if (!external.DATABASE_URL) {
    throw new UsageError(
      "deploy runs the app on Render, and the database comes from your provider (Render Postgres, Neon, Supabase, ...): put DATABASE_URL in .env.production, or pass --env-file, then run deploy again.",
    );
  }
  const source = await gitSource(root);

  if (args.dryRun) {
    const preview = planVariables({ modules: project.modules, keys, url: ownUrl ?? `https://${name}.onrender.com`, existing: {}, envFile, secret: () => "<generated>", databases: {}, clientAddress: clientAddresses.render });
    const { NODE_ENV: _node, PORT: _port, ...values } = preview.set;
    log.message(
      [
        `• Render web service "${name}" (Docker, starter instance), built from ${source.repo} (${source.branch})`,
        `• Variables: ${Object.keys(values).join(", ")}`,
        ...(preview.unset.length ? [`• Not set: ${preview.unset.join(", ")}`] : []),
        "• A deploy: the image build, the migrations before the release, the /api/health check",
      ].join("\n"),
    );
    outro("Dry run: nothing was created. Run again without --dry-run to deploy.");
    return;
  }

  note(
    [
      "This deploys the project to Render, in your Render account:",
      "",
      `• A web service "${name}" that builds the Dockerfile from ${source.repo} (${source.branch}), and deploys again on each push.`,
      "• A starter instance: pre-deploy commands, which run the migrations before each release, need a paid instance type.",
      "• The production variables from the env file, the public URL, and a generated BETTER_AUTH_SECRET when the project uses Better Auth.",
      "• Render builds the image, runs the migrations, and checks /api/health; the first build takes several minutes.",
      "",
      `Render bills the instance on your plan (${renderPricingUrl}). Running deploy again reuses the service.`,
    ].join("\n"),
    "Deploy to Render",
  );
  if (!args.yes) {
    if (!process.stdin.isTTY) throw new UsageError("deploy creates a service in your Render account. Run it in a terminal to confirm, or pass --yes.");
    const answer = await confirm({ message: "Deploy?", initialValue: true });
    if (isCancel(answer) || !answer) {
      cancel("Nothing was deployed.");
      return;
    }
  }

  const key = await apiKey();
  const owner = await workspace(key, args);
  const progress = spinner();
  progress.start("Finding or creating the Render service");
  let service: RenderService | null = parseRenderService(
    await render(key, "GET", `/services?name=${encodeURIComponent(name)}&ownerId=${encodeURIComponent(owner)}&limit=20`),
    name,
  );
  let deployId: string | null = null;
  let url = ownUrl ?? service?.url ?? `https://${name}.onrender.com`;
  const current = service ? parseRenderEnv(await render(key, "GET", `/services/${service.id}/env-vars?limit=100`)) : {};
  const plan = planVariables({ modules: project.modules, keys, url, existing: current, envFile, secret, databases: {}, clientAddress: clientAddresses.render });
  // Render sets the port, and the Dockerfile NODE_ENV.
  const { NODE_ENV: _node, PORT: _port, ...values } = plan.set;

  if (!service) {
    const created = await render<{ service?: unknown; deployId?: unknown }>(key, "POST", "/services", renderServiceBody({ name, ownerId: owner, ...source, values }));
    service = parseRenderService(created);
    if (!service) throw new Error(`Render created no service "${name}". Create it in the dashboard (New, then Blueprint, with render.yaml), then run deploy again.`);
    deployId = typeof created.deployId === "string" ? created.deployId : null;
    // Render picks another subdomain when the name is taken: the build compiles the public URL in.
    if (!ownUrl && service.url && service.url !== url) {
      url = service.url;
      log.info(`Render named the app ${url}. Setting it as the public URL and deploying again, since the build compiles it in.`);
      for (const urlKey of appUrlKeys) await render(key, "PUT", `/services/${service.id}/env-vars/${urlKey}`, { value: url });
      // The deploy that creating the service started builds the old URL in, and would run the
      // migrations alongside the next one: cancel it first. It may have ended already.
      if (deployId) await render(key, "POST", `/services/${service.id}/deploys/${deployId}/cancel`).catch(() => null);
      deployId = null;
    }
  } else {
    progress.message("Setting the production variables");
    for (const [envKey, value] of Object.entries(values)) {
      if (current[envKey] === value) continue;
      await render(key, "PUT", `/services/${service.id}/env-vars/${envKey}`, { value });
    }
  }
  progress.stop(`Render is ready: the service "${service.name}"`);

  if (plan.unset.length) {
    log.warn(`Not set: ${plan.unset.join(", ")}. The app starts without them, but the features that use them fail until they are set.`);
  }

  const deploying = spinner();
  deploying.start("Starting the deploy");
  if (!deployId) {
    const started = await render<{ id?: unknown }>(key, "POST", `/services/${service.id}/deploys`, { clearCache: "do_not_clear" });
    deployId = typeof started?.id === "string" ? started.id : null;
  }
  if (!deployId) throw new Error(`Render started no deploy. Start one in the dashboard, or run deploy again.`);
  const begun = Date.now();
  let status = "created";
  while (!(renderFinalStatuses as readonly string[]).includes(status)) {
    if (Date.now() - begun > 45 * 60_000) break;
    const elapsed = Math.round((Date.now() - begun) / 1000);
    deploying.message(`Render: ${status.replaceAll("_", " ")} (${Math.floor(elapsed / 60)}m ${elapsed % 60}s; the first build takes several minutes)`);
    await new Promise((wait) => setTimeout(wait, 10_000));
    const deploy = await render<{ status?: unknown }>(key, "GET", `/services/${service.id}/deploys/${deployId}`).catch(() => null);
    if (typeof deploy?.status === "string") status = deploy.status;
  }
  if (status !== "live") {
    deploying.stop(`The deploy ended as ${status.replaceAll("_", " ")}`);
    throw new Error(
      `Render's deploy ended as ${status}. Its logs in the dashboard say why (https://dashboard.render.com/web/${service.id}). Fix the cause and run deploy again: it reuses the service.`,
    );
  }
  deploying.stop("Deployed: the migrations ran and /api/health answered");

  note(
    [
      `${bold("URL")}      ${url}`,
      `${bold("Service")}  ${service.name}`,
      ...(plan.unset.length ? ["", `${bold("Not set")}  ${plan.unset.join(", ")}`, dim("Set the ones your modules use in the service's Environment settings.")] : []),
    ].join("\n"),
    "Deployed to Render",
  );
  if (args.open && process.stdin.isTTY && !args.yes && (await openUrl(url))) log.info("Opened the app in your browser.");
  outro(
    [
      `${dim("Dashboard")} https://dashboard.render.com/web/${service.id}`,
      `${dim("Again")}     ${cli} deploy   ${dim("(reuses the service; .env.production adds variables)")}`,
    ].join("\n"),
  );
}
