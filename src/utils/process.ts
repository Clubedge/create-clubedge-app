import { spawn } from "node:child_process";
import process from "node:process";

// Package manager shims on Windows are .cmd files, which need a shell to start.
const useShell = process.platform === "win32";

/** Runs a command with inherited output. Rejects on a non-zero exit. */
export async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: useShell });
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
    const child = spawn(command, args, {
      cwd,
      shell: useShell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
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
