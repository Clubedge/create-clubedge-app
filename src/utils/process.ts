import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import process from "node:process";

// Package manager shims on Windows are .cmd files, which need a shell to start.
const useShell = process.platform === "win32";

/** An argument as one word for cmd.exe: plain words as they are, anything else in double quotes. */
export function quoteForCmd(argument: string): string {
  return /^[\w@+=:,./\\-]+$/.test(argument) ? argument : `"${argument.replaceAll('"', '""')}"`;
}

/**
 * Starts a command, through the shell on Windows. There it passes one quoted command line, not an
 * argument list: Node warns (DEP0190) when arguments are only concatenated for a shell.
 */
export function spawnCommand(command: string, args: string[], options: SpawnOptions, shell = useShell): ChildProcess {
  if (!shell) return spawn(command, args, options);
  return spawn([command, ...args].map(quoteForCmd).join(" "), { ...options, shell: true });
}

/** Runs a command with inherited output. Rejects on a non-zero exit. */
export async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnCommand(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}.`));
    });
  });
}

/** Runs a command and returns trimmed stdout. Rejects with stderr on a non-zero exit. */
export async function runCapture(command: string, args: string[], cwd?: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawnCommand(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    // close, not exit: it fires once stdout and stderr are fully read.
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      reject(new Error(`${command} exited with ${reason}${stderr.trim() ? `: ${stderr.trim()}` : "."}`));
    });
  });
}

export async function commandSucceeds(command: string, args: string[]): Promise<boolean> {
  try {
    await runCapture(command, args);
    return true;
  } catch {
    return false;
  }
}
