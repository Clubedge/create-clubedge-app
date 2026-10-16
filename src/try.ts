import { cancel, confirm, isCancel, log, note, outro, select, spinner } from "@clack/prompts";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import ssh2 from "ssh2";
import { UsageError, type CliArgs } from "./cli/args.js";
import { bold, dim } from "./cli/ui.js";
import {
  hostKeyFingerprint,
  lastVmPath,
  portForwardCommand,
  parseRailwayStatus,
  projectTryProblem,
  proxySource,
  railwayFreeVmUrl,
  railwayHost,
  railwayKeyPath,
  railwayTermsUrl,
  remoteArchivePath,
  remoteDevLog,
  remoteLog,
  remoteName,
  remoteProxyPath,
  remoteScriptPath,
  shellQuote,
  trustedHostKeys,
  tryCreateArgs,
  tryModules,
  tryScript,
  vmPhase,
  type LastVm,
  type RailwayVm,
  type TrySource,
} from "./core/railway.js";
import { parseEnvFile } from "./core/deploy.js";
import { ProjectError, readProject, type Project } from "./core/project.js";
import { createNeonDatabase, localEnvPath } from "./neon.js";
import { uploadableFiles } from "./core/upload.js";
import { cliVersion } from "./package-info.js";
import { openUrl } from "./utils/open.js";
import { createTarGz } from "./utils/tar.js";

const { Client, utils } = ssh2;
type Connection = InstanceType<typeof Client>;

/** The CLI's own key: created on first use, then reused so later runs reach the same VM. */
async function loadOrCreateKey(path: string): Promise<{ privateKey: string; created: boolean }> {
  try {
    return { privateKey: await readFile(path, "utf8"), created: false };
  } catch {
    const pair = utils.generateKeyPairSync("ed25519", { comment: "create-clubedge-app try" });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, pair.private, { mode: 0o600 });
    await chmod(path, 0o600).catch(() => {});
    await writeFile(`${path}.pub`, `${pair.public}\n`);
    return { privateKey: pair.private, created: true };
  }
}

/** Opens the SSH connection, accepting only Railway's pinned host key. */
async function connect(privateKey: string): Promise<Connection> {
  const trusted = trustedHostKeys();
  let seen = "";
  return await new Promise<Connection>((resolve, reject) => {
    const connection = new Client();
    connection
      .once("ready", () => resolve(connection))
      .once("error", (error: Error) => {
        if (seen && !trusted.includes(seen)) {
          reject(
            new Error(
              `${railwayHost} presented an unknown host key (${seen}), so the CLI did not connect. ` +
                `If Railway announced a new key, set CLUBEDGE_RAILWAY_HOST_KEY=${seen} and run again.`,
            ),
          );
        } else if (/authentication/i.test(error.message)) {
          reject(new Error(`Railway refused the connection. The free VM may be paused or at its daily limit; see ${railwayFreeVmUrl}.`));
        } else {
          reject(new Error(`Could not reach ${railwayHost}: ${error.message}`));
        }
      })
      .connect({
        host: railwayHost,
        port: 22,
        username: userInfo().username || "clubedge",
        privateKey,
        readyTimeout: 30_000,
        keepaliveInterval: 15_000,
        hostVerifier: (key: Buffer) => {
          seen = hostKeyFingerprint(key);
          return trusted.includes(seen);
        },
      });
  });
}

interface ExecResult {
  code: number;
  stdout: string;
  vm: RailwayVm | null;
}

/**
 * Runs a command on the VM. Railway's status line on stderr is taken out and parsed; stdout lines
 * go to onLine as they arrive.
 */
async function exec(
  connection: Connection,
  command: string,
  { input, onLine }: { input?: string | Buffer; onLine?: (line: string) => void } = {},
): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolve, reject) => {
    connection.exec(command, (error, stream) => {
      if (error) return reject(error);
      let stdout = "";
      let stderr = "";
      let pending = "";
      stream.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        pending += text;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) onLine?.(line.replace(/\r$/, ""));
      });
      stream.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      stream.once("close", (code: number | null) => {
        if (pending) onLine?.(pending);
        try {
          resolve({ code: code ?? 1, stdout, vm: parseRailwayStatus(stderr) });
        } catch (parseError) {
          reject(parseError);
        }
      });
      if (input !== undefined) stream.end(input);
      else stream.end();
    });
  });
}

/** Writes a file on the VM through the command's stdin. */
async function upload(connection: Connection, path: string, content: string | Buffer): Promise<void> {
  const { code } = await exec(connection, `cat > ${shellQuote(path)}`, { input: content });
  if (code !== 0) throw new Error(`Could not write ${path} on the VM.`);
}

// A spinner line wider than the terminal wraps, and each frame then prints a new line.
const fit = (text: string) => {
  const width = (process.stdout.columns ?? 80) - 6;
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
};

function minutesLeft(until: Date): number {
  return Math.max(0, Math.round((until.getTime() - Date.now()) / 60_000));
}

const megabytes = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

/** The project this command runs in, or null outside one. A project too old to read is an error. */
async function currentProject(): Promise<Project | null> {
  try {
    return await readProject(process.cwd());
  } catch (error) {
    if (error instanceof ProjectError && /No Clubedge project found/.test(error.message)) return null;
    throw error;
  }
}

/** A hosted database for the VM: this project's, from its env file. */
type Database = { url: string; directUrl: string };

/** What goes to the VM: a new project's selection, or this project's files. */
type Plan =
  | { kind: "create"; modules: Record<string, string>; summary: string }
  | { kind: "upload"; modules: Record<string, string>; summary: string; project: Project; paths: string[]; database?: Database };

async function plan(args: CliArgs): Promise<Plan> {
  const project = await currentProject();
  if (!project) {
    const modules = tryModules(args.modules);
    const flags = tryCreateArgs({ framework: args.framework, modules, ref: args.ref }).join(" ");
    return { kind: "create", modules, summary: `Create a new project on the VM: create-clubedge-app@${cliVersion} my-app ${flags}` };
  }
  if (args.framework !== undefined || Object.keys(args.modules).length || args.ref !== undefined) {
    throw new UsageError(
      "--framework, module flags, and --ref choose a new project. Inside a project, try uploads the project as it is; run try outside it to create a new one.",
    );
  }
  const problem = projectTryProblem(project.modules);
  if (problem) throw new UsageError(problem);
  const paths = await uploadableFiles(project.root);
  if (!paths.includes("package.json")) throw new UsageError(`Nothing to upload from ${project.root}.`);
  // Env files stay here, so the VM gets the hosted database's URLs on their own.
  let database: Database | undefined;
  if (project.modules.infra === "neon") {
    const env = parseEnvFile(await readFile(join(project.root, localEnvPath), "utf8").catch(() => ""));
    if (!env.DATABASE_URL) {
      throw new UsageError(`${localEnvPath} has no DATABASE_URL for the VM to use. Create a free Neon database with \`pnpm clubedge neon create\`, then run try again.`);
    }
    database = { url: env.DATABASE_URL, directUrl: env.DATABASE_URL_DIRECT || env.DATABASE_URL };
  }
  return {
    ...(database ? { database } : {}),
    kind: "upload",
    modules: project.modules,
    project,
    paths,
    summary: `Upload ${project.identity.packageName} (${paths.length} files from ${project.root}): what Git would commit, without .env files or node_modules`,
  };
}

async function agree(args: CliArgs, keyPath: string, what: Plan): Promise<boolean> {
  note(
    [
      what.kind === "create"
        ? "This creates a free, temporary Linux VM on Railway and runs a new project there."
        : "This creates a free, temporary Linux VM on Railway, uploads this project, and runs it there.",
      "",
      ...(what.kind === "upload"
        ? [
            `• Uploads ${what.paths.length} files: what Git would commit. .env files (other than examples) and node_modules stay here; the VM makes its env files from .env.example.`,
          ]
        : []),
      ...(what.modules.infra === "neon"
        ? [
            what.kind === "upload"
              ? "• Sends DATABASE_URL and DATABASE_URL_DIRECT from your env file to the VM, so the app there uses your Neon database."
              : "• Creates a free Neon database for it (no account; Neon keeps it 72 hours unless you claim it).",
          ]
        : []),
      `• No Railway account is needed. You get 60 minutes, then 24 hours to claim the VM to keep it.`,
      `• Until you claim the VM, only you can open the preview: from the IP address that created it (this connection). Your phone on mobile data, a VPN, or anyone else get Access denied.`,
      `• Railway allows 3 free VMs per network per day.`,
      `• The CLI uses its own SSH key, ${keyPath}; your ~/.ssh is not used.`,
      `• Railway's terms apply: ${railwayTermsUrl}`,
      "",
      dim(`Experimental: Railway can change or pause its free VM (${railwayFreeVmUrl}).`),
    ].join("\n"),
    "Try it on Railway",
  );
  if (args.yes) return true;
  if (!process.stdin.isTTY) {
    throw new UsageError("try creates a VM on Railway. Run it in a terminal to confirm, or pass --yes to agree.");
  }
  const answer = await confirm({ message: "Create the VM?", initialValue: true });
  return !isCancel(answer) && answer;
}

async function saveLastVm(vm: LastVm) {
  const path = lastVmPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(vm, null, 2)}\n`);
}

async function readLastVm(): Promise<LastVm | null> {
  try {
    return JSON.parse(await readFile(lastVmPath(), "utf8")) as LastVm;
  } catch {
    return null;
  }
}

/**
 * Claiming moves the VM into a Railway account, which is what makes the preview shareable: offer
 * it at a terminal, or open it straight away with --claim. Nothing happens in scripts without it.
 */
async function offerClaim(args: CliArgs, atTerminal: boolean, claimUrl: string) {
  let claim = args.claim;
  if (!claim && atTerminal && !args.yes) {
    const answer = await select({
      message: "Share the preview with others?",
      initialValue: "later",
      options: [
        { value: "later", label: "Not now", hint: "only you can open it, from this connection" },
        { value: "claim", label: "Claim the VM", hint: "free Railway sign-up; then the URL works for anyone" },
      ],
    });
    claim = !isCancel(answer) && answer === "claim";
  }
  if (!claim) return;
  if (atTerminal && (await openUrl(claimUrl))) log.info("Opened the claim page. Sign up, pick a workspace, and the VM, its files, and its URL move to your account.");
  else log.info(`Claim the VM here: ${claimUrl}`);
}

/**
 * The last VM, from what the CLI saved: its preview, time left, and claim link. It connects only
 * while the VM is inside its 60 minutes, since connecting to a VM that is gone creates a new one.
 */
async function showStatus(keyPath: string) {
  const last = await readLastVm();
  if (!last) {
    outro("No VM yet. Run try to create one.");
    return;
  }
  const { phase, minutesLeft: left, claimUntil } = vmPhase(last);
  if (phase === "gone") {
    outro(`The last VM is gone: its claim window ended ${claimUntil.toLocaleString()}. Run try to create a new one.`);
    return;
  }
  let app = dim("not checked");
  if (phase === "running") {
    const progress = spinner();
    progress.start("Checking the app on the VM");
    try {
      const connection = await connect(await readFile(keyPath, "utf8"));
      try {
        const { stdout } = await exec(connection, "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ || true");
        app = /^[1-4]\d\d$/.test(stdout.trim()) ? "running" : "not answering";
      } finally {
        connection.end();
      }
      progress.stop("Checked the app");
    } catch (error) {
      progress.stop("Could not reach the VM");
      app = dim(error instanceof Error ? error.message : String(error));
    }
  }
  note(
    [
      `${bold("Preview")}  ${last.previewUrl}`,
      `${bold("Project")}  ${last.directory}`,
      `${bold("App")}      ${phase === "running" ? app : "stopped: the 60 minutes are over"}`,
      phase === "running"
        ? `${bold("Time")}     ${left} minutes left (until ${new Date(last.expiresAt).toLocaleTimeString()})`
        : `${bold("Time")}     claimable until ${claimUntil.toLocaleString()}`,
      `${bold("Claim")}    ${last.claimUrl}`,
    ].join("\n"),
    "Your VM on Railway",
  );
  outro(
    phase === "running"
      ? "Until you claim the VM, only this IP address can open the preview. Claim it to share the URL."
      : "Claim the VM to keep it: its files and URL move to your Railway account.",
  );
}

export async function tryOnRailway(args: CliArgs): Promise<void> {
  if (args.status) return await showStatus(railwayKeyPath());
  const what = await plan(args);
  const keyPath = railwayKeyPath();

  if (args.dryRun) {
    log.message(
      [
        `• Connect to ${railwayHost} with the key in ${keyPath}`,
        `• ${what.summary}`,
        what.modules.infra === "local"
          ? "• Start the local database (PGlite), migrate, and start the app behind the preview URL"
          : what.modules.infra === "neon"
            ? `• ${what.kind === "create" ? "Create a free Neon database" : "Use the Neon database in your env file"}, migrate, and start the app behind the preview URL`
            : "• Start the app behind the preview URL",
        ...(what.kind === "upload" ? ["", dim(what.paths.join("\n"))] : []),
      ].join("\n"),
    );
    outro("Dry run: no VM was created. Run again without --dry-run to try it.");
    return;
  }

  if (!(await agree(args, keyPath, what))) {
    cancel("No VM was created.");
    return;
  }

  const progress = spinner();
  progress.start(`Connecting to ${railwayHost}`);
  let spinning: "connect" | "setup" | null = "connect";
  let connection: Connection | undefined;
  try {
    const key = await loadOrCreateKey(keyPath);
    if (key.created) log.info(`Created an SSH key for Railway in ${keyPath}`);
    connection = await connect(key.privateKey);

    // Before the VM's clock starts: Neon answers in seconds.
    let database = what.kind === "upload" ? what.database : undefined;
    let neonExpires: Date | null = null;
    if (what.kind === "create" && what.modules.infra === "neon") {
      progress.message("Creating a free Neon database");
      const created = await createNeonDatabase("try on Railway");
      database = { url: created.url, directUrl: created.directUrl };
      neonExpires = new Date(created.database.expiresAt);
    }

    const { vm } = await exec(connection, "true");
    if (!vm) throw new Error(`${railwayHost} did not describe the VM. Railway may have changed its free VM; see ${railwayFreeVmUrl}.`);
    progress.stop(`VM ready, ${minutesLeft(vm.expiresAt)} minutes to try it`);

    spinning = "setup";
    let source: TrySource;
    if (what.kind === "upload") {
      progress.start(`Uploading ${what.paths.length} files`);
      const { archive, bytes } = await createTarGz(what.project.root, what.paths);
      await upload(connection, remoteArchivePath, archive);
      progress.message(`Uploaded ${megabytes(bytes)} (${megabytes(archive.length)} compressed)`);
      source = { kind: "upload", name: remoteName(what.project.identity.packageName) };
    } else {
      progress.start("Preparing the VM");
      source = { kind: "create", cliVersion, framework: args.framework, ref: args.ref };
    }
    await upload(connection, remoteProxyPath, proxySource);
    await upload(connection, remoteScriptPath, tryScript({ source, modules: what.modules, previewUrl: vm.previewUrl, ...(database ? { database } : {}) }));

    const tail: string[] = [];
    let failure = "";
    let directory = "";
    const started = Date.now();
    const { code } = await exec(connection, `bash ${remoteScriptPath}`, {
      onLine: (line) => {
        if (line.startsWith("@@step ")) progress.message(fit(`${line.slice(7)} (${Math.round((Date.now() - started) / 1000)}s)`));
        else if (line.startsWith("@@log ")) tail.push(line.slice(6));
        else if (line.startsWith("@@fail ")) failure = line.slice(7);
        else if (line.startsWith("@@ready")) directory = line.slice(8).trim();
      },
    });
    if (code !== 0 || failure) {
      spinning = null;
      progress.stop(failure || "Setup on the VM failed");
      if (tail.length) log.message(dim(tail.join("\n")));
      throw new Error(`Setup on the VM failed. Its log is ${remoteLog}; read it with: ssh -i "${keyPath}" ${railwayHost} cat ${remoteLog}`);
    }
    spinning = null;
    progress.stop(`The app is running in /app/${directory}`);

    note(
      [
        `${bold("Preview")}  ${vm.previewUrl}`,
        `${bold("Time")}     ${minutesLeft(vm.expiresAt)} minutes left (until ${vm.expiresAt.toLocaleTimeString()})`,
        `${bold("Claim")}    ${vm.claimUrl}`,
        ...(neonExpires
          ? [`${bold("Database")} Neon, free until ${neonExpires.toLocaleString()}; keep it with: pnpm dlx @clubedge/create-clubedge-app neon claim`]
          : []),
      ].join("\n"),
      "Your app on Railway",
    );
    log.warn("Keep the claim link private: whoever opens it takes over the VM, its files, and its URL.");
    await saveLastVm({ previewUrl: vm.previewUrl, claimUrl: vm.claimUrl, expiresAt: vm.expiresAt.toISOString(), directory: `/app/${directory}` });

    // Only for a person at a terminal: scripts and CI get the URLs above, and nothing opens.
    const atTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (args.open && atTerminal && (await openUrl(vm.previewUrl))) log.info("Opened the preview in your browser.");
    await offerClaim(args, atTerminal, vm.claimUrl);
    outro(
      [
        "Until you claim the VM, only you can open the preview, from the IP address that created it. Another device on mobile data, a VPN, or anyone you send it to gets Railway's \"Access denied\" page. Claiming makes the URL shareable.",
        "",
        `${dim("Status")}   ${dim("pnpm dlx @clubedge/create-clubedge-app try --status")}`,
        `${dim("Local")}    ${portForwardCommand(keyPath)}  ${dim("then http://localhost:3000, from any network")}`,
        `${dim("Shell")}    ssh -i "${keyPath}" ${railwayHost}`,
        `${dim("Logs")}     ssh -i "${keyPath}" ${railwayHost} tail -f ${remoteDevLog}`,
      ].join("\n"),
    );
  } catch (error) {
    if (spinning) progress.stop(spinning === "connect" ? "Could not start a VM on Railway" : "Setup on the VM failed");
    throw error;
  } finally {
    connection?.end();
  }
}
