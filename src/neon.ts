// `neon`: the free Neon database a project with --infra neon gets. `neon` shows where it stands,
// `neon claim` opens the page that moves it into a Neon account, and `neon create` makes a new one.
// create, `add infra neon`, and `try --infra neon` create theirs through provisionNeonDatabase.
import { confirm, isCancel, log, note, outro, spinner } from "@clack/prompts";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { UsageError, type CliArgs } from "./cli/args.js";
import { bold } from "./cli/ui.js";
import { parseEnvFile } from "./core/deploy.js";
import {
  addNeonDatabase,
  createClaimableDatabase,
  hoursLeft,
  isNeonUrl,
  neonClaimUrl,
  neonConsoleUrl,
  neonDatabaseState,
  neonStatePath,
  parseNeonState,
  savedDatabaseFor,
  setDeclaredEnvValues,
  setEnvValues,
  type CreatedDatabase,
  type NeonDatabase,
} from "./core/neon.js";
import { databaseEnvFile, ProjectError, projectEnvFiles, readProject, type Project } from "./core/project.js";
import { openUrl } from "./utils/open.js";

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function savedNeonDatabases(): Promise<NeonDatabase[]> {
  return parseNeonState(await readText(neonStatePath()));
}

/** Writes the state file through a temporary file, readable only by the user: it holds secrets. */
async function saveNeonDatabase(database: NeonDatabase) {
  const path = neonStatePath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, addNeonDatabase(await readText(path), database), { mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, path);
}

/** Creates a free Neon database and remembers it, so `neon claim` can claim it later. */
export async function createNeonDatabase(project: string): Promise<CreatedDatabase> {
  const created = await createClaimableDatabase({ project });
  await saveNeonDatabase(created.database);
  return created;
}

/**
 * Creates a free Neon database and writes its URLs into the env file of the app that owns the
 * database. Other apps' env files (`shared`) get the database variables they already declare,
 * so a second server that connects too, such as Better Auth's in a Vite frontend, uses the same one.
 */
export async function provisionNeonDatabase(root: string, envPath: string, shared: string[] = []): Promise<CreatedDatabase> {
  const created = await createNeonDatabase(root);
  const values = { DATABASE_URL: created.url, DATABASE_URL_DIRECT: created.directUrl };
  await writeFile(join(root, envPath), setEnvValues((await readText(join(root, envPath))) ?? "", values));
  for (const path of shared.filter((other) => other !== envPath)) {
    const text = await readText(join(root, path));
    const updated = text === null ? null : setDeclaredEnvValues(text, values);
    if (updated !== null) await writeFile(join(root, path), updated);
  }
  return created;
}

/** Where `neon create` and `add infra neon` write the database URLs in a project, and the env files that share them. */
export function projectDatabaseEnv(project: Project): { envPath: string; shared: string[] } {
  return { envPath: databaseEnvFile(project).local, shared: projectEnvFiles(project).map(({ local }) => local) };
}

const expiry = (database: NeonDatabase) => new Date(database.expiresAt).toLocaleString();

/** What create and `add infra neon` print once the database is there. */
export function describeNewDatabase(created: CreatedDatabase, cli: string): string {
  return `Created a free Neon database (until ${expiry(created.database)}). Keep it with \`${cli} neon claim\`.`;
}

async function currentProject(): Promise<Project | null> {
  try {
    return await readProject(process.cwd());
  } catch (error) {
    if (error instanceof ProjectError && /No Clubedge project found/.test(error.message)) return null;
    throw error;
  }
}

async function projectDatabaseUrl(project: Project) {
  return parseEnvFile((await readText(join(project.root, databaseEnvFile(project).local))) ?? "").DATABASE_URL ?? "";
}

/** The saved database to act on: the one the project's env file uses, or outside a project the newest. */
async function targetDatabase(project: Project | null): Promise<NeonDatabase | null> {
  const saved = await savedNeonDatabases();
  if (project) return savedDatabaseFor(saved, await projectDatabaseUrl(project));
  return saved[0] ?? null;
}

const cliFor = (project: Project | null) => (project ? "pnpm clubedge" : "pnpm dlx @clubedge/create-clubedge-app");

async function showStatus(project: Project | null) {
  const cli = cliFor(project);
  const database = await targetDatabase(project);
  if (!database) {
    if (!project) {
      outro(`No Neon database yet. Create a project with --infra neon, or run try --infra neon.`);
      return;
    }
    const url = await projectDatabaseUrl(project);
    outro(
      !url
        ? `${databaseEnvFile(project).local} has no DATABASE_URL. Create a free Neon database with \`${cli} neon create\`.`
        : isNeonUrl(url)
          ? "DATABASE_URL points at a Neon database this CLI didn't create, such as your own project: nothing to claim."
          : "DATABASE_URL doesn't point at Neon.",
    );
    return;
  }
  const progress = spinner();
  progress.start("Asking Neon");
  const state = await neonDatabaseState(database);
  progress.stop("Neon answered");
  const status =
    state.kind === "unclaimed"
      ? `unclaimed: ${state.hoursLeft} hours left (until ${expiry(database)})`
      : state.kind === "claimed"
        ? "claimed into a Neon account"
        : state.kind === "expired"
          ? "expired: Neon deleted it"
          : `unknown (${state.reason}); it expires ${expiry(database)} unless claimed`;
  note(
    [`${bold("Project")}   ${database.projectId}`, `${bold("Host")}      ${database.host}`, `${bold("Status")}    ${status}`, `${bold("For")}       ${database.project}`].join("\n"),
    "Neon database",
  );
  outro(
    state.kind === "claimed"
      ? `Claiming reset its password: copy the pooled and direct connection strings from ${neonConsoleUrl} into DATABASE_URL and DATABASE_URL_DIRECT.`
      : state.kind === "expired"
        ? `Create a new one with \`${cli} neon create\`, then run \`pnpm db:migrate\`.`
        : `Keep it with \`${cli} neon claim\`: a free Neon account, and the data stays.`,
  );
}

async function claim(args: CliArgs, project: Project | null) {
  const database = await targetDatabase(project);
  if (!database) {
    throw new UsageError(
      project
        ? `${databaseEnvFile(project).local} doesn't use a database this CLI created, so there is nothing to claim. Your own Neon projects are already yours.`
        : "No Neon database to claim. Run this inside the project, or after try --infra neon.",
    );
  }
  if (hoursLeft(database.expiresAt) <= 0) {
    throw new UsageError(`The database expired ${expiry(database)}, and Neon deleted it. Create a new one with \`${cliFor(project)} neon create\`.`);
  }
  const progress = spinner();
  progress.start("Asking Neon for a claim link");
  let url: string;
  try {
    url = await neonClaimUrl(database);
  } catch (error) {
    progress.stop("Neon gave no claim link");
    throw error;
  }
  progress.stop("Claim link ready");
  const atTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (args.open && atTerminal && (await openUrl(url))) log.info("Opened Neon's claim page in your browser.");
  else log.info(`Claim the database here: ${url}`);
  log.warn("The link works for 15 minutes, and whoever opens it gets the database: keep it private.");
  outro(
    `After claiming, Neon resets the password: copy the pooled and direct connection strings from ${neonConsoleUrl} into DATABASE_URL and DATABASE_URL_DIRECT${project ? ` in ${databaseEnvFile(project).local}` : ""}.`,
  );
}

async function create(args: CliArgs, project: Project | null) {
  if (!project) throw new UsageError("neon create writes the database URLs into a project: run it inside one.");
  const { envPath, shared } = projectDatabaseEnv(project);
  const current = await projectDatabaseUrl(project);
  const saved = savedDatabaseFor(await savedNeonDatabases(), current);
  // Replacing a database that isn't one of ours, or one that is still alive, loses its data here.
  const replacing = current && !(saved && hoursLeft(saved.expiresAt) <= 0);
  if (args.dryRun) {
    log.message(`• Create a free Neon database (72 hours unless claimed)\n• Set DATABASE_URL and DATABASE_URL_DIRECT in ${envPath}`);
    outro("Dry run: nothing was created.");
    return;
  }
  if (replacing && !args.yes) {
    if (!process.stdin.isTTY) throw new UsageError(`${envPath} already has a DATABASE_URL. Pass --yes to replace it.`);
    const answer = await confirm({ message: `Replace the DATABASE_URL in ${envPath} with a new, empty database?`, initialValue: false });
    if (isCancel(answer) || !answer) {
      outro("Nothing was changed.");
      return;
    }
  }
  const progress = spinner();
  progress.start("Creating a Neon database");
  let created: CreatedDatabase;
  try {
    created = await provisionNeonDatabase(project.root, envPath, shared);
  } catch (error) {
    progress.stop("Neon created no database");
    throw error;
  }
  progress.stop(describeNewDatabase(created, cliFor(project)));
  outro(`Wrote DATABASE_URL and DATABASE_URL_DIRECT to ${envPath}. Create the tables with \`pnpm db:migrate\`.`);
}

export async function neonCommand(args: CliArgs): Promise<void> {
  if (args.command.name !== "neon") throw new Error("Not the neon command.");
  const project = await currentProject();
  const action = args.command.action;
  if (action === "claim") return await claim(args, project);
  if (action === "create") return await create(args, project);
  return await showStatus(project);
}

/** For doctor and deploy: the saved database the env file's DATABASE_URL uses, if any. */
export async function savedDatabaseForUrl(url: string | undefined): Promise<NeonDatabase | null> {
  return savedDatabaseFor(await savedNeonDatabases(), url);
}
