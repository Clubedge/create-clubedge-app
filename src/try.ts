import { cancel, confirm, isCancel, log, note, outro, spinner } from "@clack/prompts";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname } from "node:path";
import process from "node:process";
import ssh2 from "ssh2";
import { UsageError, type CliArgs } from "./cli/args.js";
import { bold, dim } from "./cli/ui.js";
import {
  hostKeyFingerprint,
  parseRailwayStatus,
  proxySource,
  railwayFreeVmUrl,
  railwayHost,
  railwayKeyPath,
  railwayTermsUrl,
  remoteDevLog,
  remoteLog,
  remoteProxyPath,
  remoteScriptPath,
  shellQuote,
  trustedHostKeys,
  tryCreateArgs,
  tryModules,
  tryScript,
  type RailwayVm,
} from "./core/railway.js";
import { cliVersion } from "./package-info.js";

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
  { input, onLine }: { input?: string; onLine?: (line: string) => void } = {},
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
async function upload(connection: Connection, path: string, content: string): Promise<void> {
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

async function agree(args: CliArgs, keyPath: string): Promise<boolean> {
  note(
    [
      "This creates a free, temporary Linux VM on Railway and runs a new project there.",
      "",
      `• No Railway account is needed. You get 60 minutes, then 24 hours to claim the VM to keep it.`,
      `• The preview opens only from your network until you claim the VM.`,
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

export async function tryOnRailway(args: CliArgs): Promise<void> {
  const modules = tryModules(args.modules);
  const keyPath = railwayKeyPath();
  const createArgs = tryCreateArgs({ framework: args.framework, modules, ref: args.ref });

  if (args.dryRun) {
    log.message(
      [
        `• Connect to ${railwayHost} with the key in ${keyPath}`,
        `• Create the project: create-clubedge-app@${cliVersion} my-app ${createArgs.join(" ")}`,
        "• Start the local database (PGlite), migrate, and start the app behind the preview URL",
      ].join("\n"),
    );
    outro("Dry run: no VM was created. Run again without --dry-run to try it.");
    return;
  }

  if (!(await agree(args, keyPath))) {
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

    const { vm } = await exec(connection, "true");
    if (!vm) throw new Error(`${railwayHost} did not describe the VM. Railway may have changed its free VM; see ${railwayFreeVmUrl}.`);
    progress.stop(`VM ready, ${minutesLeft(vm.expiresAt)} minutes to try it`);

    spinning = "setup";
    progress.start("Preparing the VM");
    await upload(connection, remoteProxyPath, proxySource);
    await upload(connection, remoteScriptPath, tryScript({ cliVersion, framework: args.framework, modules, ref: args.ref, previewUrl: vm.previewUrl }));

    const tail: string[] = [];
    let failure = "";
    let directory = "my-app";
    const started = Date.now();
    const { code } = await exec(connection, `bash ${remoteScriptPath}`, {
      onLine: (line) => {
        if (line.startsWith("@@step ")) progress.message(fit(`${line.slice(7)} (${Math.round((Date.now() - started) / 1000)}s)`));
        else if (line.startsWith("@@log ")) tail.push(line.slice(6));
        else if (line.startsWith("@@fail ")) failure = line.slice(7);
        else if (line.startsWith("@@ready")) directory = line.slice(8).trim() || directory;
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
      ].join("\n"),
      "Your app on Railway",
    );
    log.warn("Keep the claim link private: whoever opens it takes over the VM, its files, and its URL.");
    outro(
      [
        "The preview opens only from your network until you claim the VM. Claiming moves it to your Railway account.",
        "",
        `${dim("Shell")}  ssh -i "${keyPath}" ${railwayHost}`,
        `${dim("Logs")}   ssh -i "${keyPath}" ${railwayHost} tail -f ${remoteDevLog}`,
      ].join("\n"),
    );
  } catch (error) {
    if (spinning) progress.stop(spinning === "connect" ? "Could not start a VM on Railway" : "Setup on the VM failed");
    throw error;
  } finally {
    connection?.end();
  }
}
