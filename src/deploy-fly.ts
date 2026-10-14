// `deploy` for Fly.io (experimental): creates or reuses the app (written to fly.toml), an
// unmanaged Postgres attached as DATABASE_URL, Upstash Redis with cache redis (each unless the env
// file points it elsewhere), sets the secrets, and runs `fly deploy`, which waits for the release
// command (migrations) and the health checks.
import { cancel, confirm, isCancel, log, note, outro, spinner } from "@clack/prompts";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { UsageError, type CliArgs } from "./cli/args.js";
import { bold, dim } from "./cli/ui.js";
import {
  exampleKeys,
  externalDatabaseUrls,
  flyAppUrl,
  flySecretNames,
  flySecretsInput,
  flyTomlValue,
  parseRedisUrl,
  planVariables,
  serviceName,
} from "./core/deploy.js";
import type { Project } from "./core/project.js";
import { spawnCommand } from "./utils/process.js";

const flyInstallUrl = "https://fly.io/docs/flyctl/install/";
const flyPricingUrl = "https://fly.io/docs/about/pricing/";

interface RunOptions {
  input?: string;
  inherit?: boolean;
}

/** Runs Fly's CLI (a binary, so no shell); values go through stdin. */
async function fly(command: string, args: string[], cwd: string, options: RunOptions = {}): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawnCommand(command, args, { cwd, stdio: options.inherit ? "inherit" : ["pipe", "pipe", "pipe"] }, false);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise(`${stdout}\n${stderr}`.trim());
      else reject(new Error(`fly ${args[0]} failed${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : "."}`));
    });
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(options.input ?? "");
    }
  });
}

const attempt = async (run: () => Promise<string>) => run().catch(() => null);

/** Fly's CLI: `fly`, or its other name `flyctl`. */
async function flyCli(cwd: string): Promise<string> {
  for (const name of ["fly", "flyctl"]) {
    if (await attempt(() => fly(name, ["version"], cwd))) return name;
  }
  throw new UsageError(`deploy to Fly.io needs Fly's CLI. Install it (${flyInstallUrl}), then run deploy again.`);
}

export async function deployToFly(args: CliArgs, project: Project, cli: string, envFile: Record<string, string>): Promise<void> {
  const root = project.root;
  const tomlPath = join(root, "fly.toml");
  const toml = await readFile(tomlPath, "utf8").catch(() => "");
  if (!toml) throw new UsageError(`This project has no fly.toml. Switch with \`${cli} add deploy fly\`.`);
  const named = flyTomlValue(toml, "app");
  // Fly app names are global: a new app gets a short random suffix.
  const app = named ?? `${serviceName(project.identity.packageName)}-${randomBytes(2).toString("hex")}`;
  const keys = exampleKeys(await readFile(join(root, ".env.example"), "utf8").catch(() => ""));
  const external = externalDatabaseUrls(project.modules, envFile);
  // The databases to create on Fly: the ones the env file doesn't point elsewhere.
  const postgres = !external.DATABASE_URL;
  const redis = project.modules.cache === "redis" && !external.REDIS_URL;
  const elsewhere = Object.keys(external);
  const hostedLine = [
    ...(postgres ? [`a Postgres app "${app}-db" (unmanaged: one shared-cpu-1x machine and a 1 GB volume)`] : []),
    ...(redis ? [`Upstash Redis "${app}-redis"`] : []),
  ];
  const secret = () => randomBytes(32).toString("hex");
  const url = flyAppUrl(app);

  if (args.dryRun) {
    const preview = planVariables({ modules: project.modules, keys, url, existing: {}, envFile, secret: () => "<generated>", databases: {}, attached: [...(postgres ? ["DATABASE_URL"] : []), ...(redis ? ["REDIS_URL"] : [])] });
    log.message(
      [
        `• Fly app "${app}"${named ? " (from fly.toml)" : ", written to fly.toml"}, at ${url}`,
        ...(postgres ? [`• Postgres "${app}-db" (unmanaged, one small machine), attached as DATABASE_URL`] : []),
        ...(redis ? [`• Upstash Redis "${app}-redis" as REDIS_URL`] : []),
        ...(elsewhere.length ? [`• ${elsewhere.join(" and ")} from the env file, instead of Fly's databases`] : []),
        `• Secrets: ${Object.keys(preview.set).join(", ")}`,
        ...(preview.unset.length ? [`• Not set: ${preview.unset.join(", ")}`] : []),
        `• fly deploy, with NEXT_PUBLIC_APP_URL as a build argument: migrations, then health checks`,
      ].join("\n"),
    );
    outro("Dry run: nothing was created. Run again without --dry-run to deploy.");
    return;
  }

  note(
    [
      "This deploys the project to Fly.io, in your Fly account (experimental):",
      "",
      `• The app "${app}"${hostedLine.length ? `, ${hostedLine.join(", and ")}` : ""}.`,
      ...(elsewhere.length ? [`• ${elsewhere.join(" and ")} from the env file: those databases stay where they are, and Fly runs the app.`] : []),
      "• The secrets Fly can't provide come from --env-file; the ones still unset are listed before the build.",
      "• fly deploy builds the Dockerfile, runs the migrations as the release command, and waits for the health checks.",
      "",
      `Fly bills these on your plan (${flyPricingUrl}). For Fly's Managed Postgres instead, create it yourself and attach it before deploying.`,
    ].join("\n"),
    "Deploy to Fly.io",
  );
  if (!args.yes) {
    if (!process.stdin.isTTY) throw new UsageError("deploy creates resources in your Fly account. Run it in a terminal to confirm, or pass --yes.");
    const answer = await confirm({ message: "Deploy?", initialValue: true });
    if (isCancel(answer) || !answer) {
      cancel("Nothing was deployed.");
      return;
    }
  }

  const progress = spinner();
  progress.start("Finding Fly's CLI");
  const flyBin = await flyCli(root);
  if (!(await attempt(() => fly(flyBin, ["auth", "whoami"], root)))) {
    progress.stop("Signing in to Fly.io");
    if (!process.stdin.isTTY) throw new UsageError("Sign in to Fly.io first with `fly auth login`, or set FLY_API_TOKEN.");
    await fly(flyBin, ["auth", "login"], root, { inherit: true });
    progress.start("Signed in");
  }

  let launched = false;
  if (!named) {
    progress.message(`Creating the app "${app}"`);
    await fly(flyBin, ["launch", "--no-deploy", "--copy-config", "--name", app, "--org", "personal", "--yes", "--no-db", "--no-redis", "--no-object-storage", "--ha=false"], root);
    launched = true;
  }
  const region = flyTomlValue(await readFile(tomlPath, "utf8"), "primary_region");
  const regionArgs = region ? ["--region", region] : [];
  const secrets = new Set(flySecretNames((await attempt(() => fly(flyBin, ["secrets", "list", "--app", app, "--json"], root))) ?? ""));

  // A DATABASE_URL secret already set (Fly's attach, or an earlier env file) is kept as it is.
  const database = `${app}-db`;
  if (postgres && !secrets.has("DATABASE_URL") && !(await attempt(() => fly(flyBin, ["status", "--app", database], root)))) {
    progress.message(`Creating Postgres "${database}"`);
    await fly(flyBin, ["postgres", "create", "--name", database, "--org", "personal", ...regionArgs, "--initial-cluster-size", "1", "--vm-size", "shared-cpu-1x", "--volume-size", "1", "--autostart"], root);
  }
  if (postgres && !secrets.has("DATABASE_URL")) {
    progress.message("Attaching Postgres (DATABASE_URL)");
    await fly(flyBin, ["postgres", "attach", database, "--app", app, "--yes"], root);
  }

  let redisUrl: string | null = null;
  if (redis && !secrets.has("REDIS_URL")) {
    progress.message(`Creating Upstash Redis "${app}-redis"`);
    redisUrl = parseRedisUrl(await fly(flyBin, ["redis", "create", "--name", `${app}-redis`, "--org", "personal", ...regionArgs, "--no-replicas", "--enable-eviction"], root));
  }

  progress.message("Setting the secrets");
  const plan = planVariables({
    modules: project.modules,
    keys,
    url,
    existing: Object.fromEntries([...secrets].map((name) => [name, "(set)"])),
    envFile,
    secret,
    databases: redisUrl ? { REDIS_URL: redisUrl } : {},
    attached: [...(postgres ? ["DATABASE_URL"] : []), ...(redis && !redisUrl && secrets.has("REDIS_URL") ? ["REDIS_URL"] : [])],
  });
  // The image sets NODE_ENV and fly.toml the port: the rest are secrets, staged for the deploy.
  const { NODE_ENV: _node, PORT: _port, ...values } = plan.set;
  await fly(flyBin, ["secrets", "import", "--app", app, "--stage"], root, { input: flySecretsInput(values) });
  progress.stop(`Fly.io is ready: ${url}`);
  if (launched) log.info(`Commit fly.toml: fly launch wrote the app's name ("${app}") and region into it.`);

  if (plan.unset.length) {
    log.warn(`Not set: ${plan.unset.join(", ")}. The app starts without them, but the features that use them fail until they are set: pass --env-file, or run fly secrets set.`);
    if (process.stdin.isTTY && !args.yes) {
      const proceed = await confirm({ message: "Deploy anyway?", initialValue: true });
      if (isCancel(proceed) || !proceed) {
        cancel("Nothing was deployed. Set them, then run deploy again: it reuses everything.");
        return;
      }
    }
  }

  log.step("Deploying with fly deploy (build logs follow; the migrations run as the release command)");
  try {
    // Next.js compiles the public URL into the build, so it goes in as a build argument too.
    await fly(flyBin, ["deploy", "--app", app, "--remote-only", "--build-arg", `NEXT_PUBLIC_APP_URL=${url}`], root, { inherit: true });
  } catch {
    throw new Error(`The deploy did not finish. Read the logs with \`fly logs --app ${app}\`, fix the cause, and run deploy again: it reuses what exists.`);
  }

  note(
    [
      `${bold("URL")}  ${url}`,
      `${bold("App")}  ${app}`,
      ...(plan.unset.length ? ["", `${bold("Not set")}  ${plan.unset.join(", ")}`] : []),
    ].join("\n"),
    "Deployed to Fly.io",
  );
  outro(
    [
      `${dim("Logs")}   fly logs --app ${app}`,
      `${dim("Status")} fly status --app ${app}`,
      `${dim("Again")}  ${cli} deploy   ${dim("(reuses the app; --env-file to add secrets)")}`,
    ].join("\n"),
  );
}
