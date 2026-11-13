import { spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from "node:child_process";
import { statSync } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

// Package manager shims on Windows are .cmd files, which need a shell to start.
const useShell = process.platform === "win32";

/** An environment variable by name, whatever its case: Windows keeps Path as it was written. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The file cmd.exe runs for a command: the path as given when it names a folder, else the first
 * match in the current folder and then PATH's folders, each with PATHEXT's extensions in order
 * unless the command already ends with one. Null when there is none.
 */
export function resolveForCmd(command: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | null {
  const extensions = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const named = extensions.some((extension) => command.toLowerCase().endsWith(extension.toLowerCase()));
  const candidates = (base: string) => (named ? [base] : extensions.map((extension) => base + extension));
  if (/[\\/:]/.test(command)) return candidates(resolve(cwd, command)).find(isFile) ?? null;
  // A folder in PATH may be written in quotes.
  const path = (envValue(env, "PATH") ?? "").split(delimiter).map((folder) => folder.replace(/^"(.*)"$/, "$1"));
  const folders = [cwd, ...path.filter(Boolean)];
  for (const folder of folders) {
    const found = candidates(join(isAbsolute(folder) ? folder : resolve(cwd, folder), command)).find(isFile);
    if (found) return found;
  }
  return null;
}

/** The characters cmd.exe gives a meaning to. A caret before one makes cmd.exe read it as text. */
const cmdSpecial = /[()\][%!^"`<>&|;, *?]/g;
const caret = (text: string) => text.replace(cmdSpecial, "^$&");

/**
 * An argument as one word of a command line that cmd.exe runs, so the program receives exactly
 * the argument: plain words as they are, and anything else quoted the way Windows programs split
 * their command line (CommandLineToArgvW: backslashes before a quote doubled, the quote escaped),
 * then with a caret before each character cmd.exe would act on. That covers quotes, so cmd.exe
 * never reads the argument as its own quoted text, and `%`, which breaks up `%VAR%`. A batch file
 * such as an npm shim passes its arguments on in a line cmd.exe reads again, so for one the carets
 * are added twice (`passes`). The method is https://qntm.org/cmd, as cross-spawn applies it.
 *
 * A line break ends the command for cmd.exe whatever surrounds it, so it's refused.
 */
export function quoteForCmd(argument: string, passes = 1): string {
  if (/[\r\n]/.test(argument)) {
    throw new Error(`An argument with a line break can't be passed to a command through cmd.exe: ${JSON.stringify(argument)}`);
  }
  if (/^[\w@+=:,./\\-]+$/.test(argument)) return argument;
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes++;
      continue;
    }
    quoted += character === '"' ? "\\".repeat(backslashes * 2 + 1) + '"' : "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  quoted += "\\".repeat(backslashes * 2) + '"';
  for (let pass = 0; pass < passes; pass++) quoted = caret(quoted);
  return quoted;
}

/**
 * The command line for cmd.exe: the command with a caret before each special character (a path
 * with spaces stays one word), then its arguments, escaped twice for a batch file.
 */
export function cmdLine(command: string, args: string[], batch: boolean): string {
  if (/[\r\n]/.test(command)) throw new Error(`A command with a line break can't run through cmd.exe: ${JSON.stringify(command)}`);
  return [caret(command), ...args.map((argument) => quoteForCmd(argument, batch ? 2 : 1))].join(" ");
}

/**
 * Starts a command. On Windows, with `shell`, it finds the file cmd.exe would run:
 * - a program (.exe, .com) starts directly, with no shell, so nothing reads its arguments but it;
 * - a batch file (.cmd, .bat), such as an npm shim, can only start through cmd.exe, and gets one
 *   command line with every argument escaped for it (Node warns, DEP0190, when arguments are only
 *   concatenated for a shell);
 * - anything else goes to cmd.exe too, which runs it or reports that it's missing.
 */
export function spawnCommand(command: string, args: string[], options: SpawnOptions, shell = useShell): ChildProcess {
  if (!shell) return spawn(command, args, options);
  const cwd = options.cwd === undefined ? process.cwd() : typeof options.cwd === "string" ? options.cwd : fileURLToPath(options.cwd);
  const file = resolveForCmd(command, options.env ?? process.env, cwd);
  if (file && /\.(exe|com)$/i.test(file)) return spawn(file, args, options);
  return spawn(cmdLine(file ?? command, args, file !== null && /\.(cmd|bat)$/i.test(file)), { ...options, shell: true });
}

/** Runs a command with inherited output. Rejects on a non-zero exit. */
export async function run(
  command: string,
  args: string[],
  cwd: string,
  stdio: StdioOptions = "inherit",
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnCommand(command, args, { cwd, stdio, env });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}.`));
    });
  });
}

/**
 * Runs a command with its output, stdout and stderr alike, written to `output`: a log a program
 * reads, or a stream that is not a file, which a child process cannot inherit. Rejects on a
 * non-zero exit.
 */
export async function runInto(
  command: string,
  args: string[],
  cwd: string,
  output: Writable,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnCommand(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env });
    // The output is the caller's: when writing to it fails, the command stops and the call fails,
    // instead of an unhandled error ending the process. The stream itself is left open.
    let writeError: Error | undefined;
    const forward = (chunk: Buffer) => {
      if (!writeError) output.write(chunk);
    };
    const onOutputError = (error: Error) => {
      writeError ??= error;
      child.kill();
    };
    output.on("error", onOutputError);
    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);
    child.once("error", (error) => {
      output.removeListener("error", onOutputError);
      reject(error);
    });
    // close, not exit: it fires once stdout and stderr are fully read.
    child.once("close", (code, signal) => {
      output.removeListener("error", onOutputError);
      if (writeError) reject(new Error(`${command}'s output could not be written: ${writeError.message}`));
      else if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}.`));
    });
  });
}

/** Runs a command and returns trimmed stdout. Rejects with stderr on a non-zero exit. */
export async function runCapture(command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawnCommand(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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

/**
 * The environment with PATH's relative folders, such as node_modules/.bin, resolved from `base`,
 * for a command started in another folder, which would look them up from there.
 */
export function withAbsolutePath(env: NodeJS.ProcessEnv = process.env, base = process.cwd()): NodeJS.ProcessEnv {
  // Windows keeps the name's own case, such as Path.
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  if (!key || !env[key]) return env;
  const folders = env[key]!.split(delimiter).map((folder) => (folder && !isAbsolute(folder) ? resolve(base, folder) : folder));
  return { ...env, [key]: folders.join(delimiter) };
}

/**
 * Whether a command is installed: a file of that name in a PATH folder, with one of PATHEXT's
 * extensions on Windows. It tells a missing command from one that fails, which cmd.exe reports
 * the same way (exit code 1).
 */
export async function onPath(command: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const extensions = useShell ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const folder of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try {
        await access(join(folder, command + extension));
        return true;
      } catch {
        // Not in this folder.
      }
    }
  }
  return false;
}
