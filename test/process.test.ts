import { existsSync } from "node:fs";
import { Writable } from "node:stream";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { cmdLine, quoteForCmd, resolveForCmd, runCapture, runInto, spawnCommand } from "../src/utils/process.js";
import { temporaryDirectory, writeFiles } from "./helpers.js";

describe("quoteForCmd", () => {
  it("leaves plain words as they are", () => {
    for (const word of ["--save-dev", "@railway/cli@latest", "C:\\Users\\Dell\\npm\\railway.exe", "--depth=1", "a,b"]) {
      expect(quoteForCmd(word)).toBe(word);
    }
  });

  it("quotes the rest for the program, with a caret before each character cmd.exe acts on", () => {
    expect(quoteForCmd("")).toBe('^"^"');
    expect(quoteForCmd("two words")).toBe('^"two^ words^"');
    expect(quoteForCmd('say "hi" & exit')).toBe('^"say^ \\^"hi\\^"^ ^&^ exit^"');
    expect(quoteForCmd("%PATH%")).toBe('^"^%PATH^%^"');
    expect(quoteForCmd("a|b>c<d^e")).toBe('^"a^|b^>c^<d^^e^"');
    expect(quoteForCmd("(x86)!now!")).toBe('^"^(x86^)^!now^!^"');
  });

  it("doubles backslashes before a quote and at the end, where they would escape the quote", () => {
    expect(quoteForCmd("C:\\My Files\\")).toBe('^"C:\\My^ Files\\\\^"');
    expect(quoteForCmd('a\\"b')).toBe('^"a\\\\\\^"b^"');
    expect(quoteForCmd("a\\b c")).toBe('^"a\\b^ c^"');
  });

  it("adds the carets twice for a batch file, which cmd.exe reads again", () => {
    expect(quoteForCmd("a&b", 2)).toBe('^^^"a^^^&b^^^"');
    expect(quoteForCmd("plain", 2)).toBe("plain");
  });

  it("refuses a line break, which ends the command for cmd.exe", () => {
    expect(() => quoteForCmd("one\ntwo")).toThrow(/line break/);
    expect(() => quoteForCmd("one\rtwo")).toThrow(/line break/);
  });
});

describe("cmdLine", () => {
  it("keeps a command's path one word and escapes each argument, twice for a batch file", () => {
    expect(cmdLine("git", ["-C", "C:\\My Projects\\app", "status"], false)).toBe('git -C ^"C:\\My^ Projects\\app^" status');
    expect(cmdLine("C:\\Program Files\\nodejs\\npx.cmd", ["--yes", "a&b"], true)).toBe(
      'C:\\Program^ Files\\nodejs\\npx.cmd --yes ^^^"a^^^&b^^^"',
    );
    expect(() => cmdLine("git\nstatus", [], false)).toThrow(/line break/);
  });
});

describe("resolveForCmd", () => {
  it("finds the file cmd.exe would run: the current folder first, then PATH, with PATHEXT's extensions in order", async () => {
    const [cwd, first, second] = [await temporaryDirectory(), await temporaryDirectory(), await temporaryDirectory()];
    await writeFiles(first, { "tool.cmd": "", "both.cmd": "", "both.exe": "" });
    await writeFiles(second, { "tool.exe": "", "later.exe": "" });
    await writeFiles(cwd, { "here.cmd": "", "bin/nested.cmd": "" });
    // A quoted folder, and the name's own case, as Windows writes them.
    const env = { Path: [`"${first}"`, second].join(delimiter), PATHEXT: ".exe;.cmd" };

    expect(resolveForCmd("tool", env, cwd)).toBe(join(first, "tool.cmd"));
    expect(resolveForCmd("both", env, cwd)).toBe(join(first, "both.exe"));
    expect(resolveForCmd("both.cmd", env, cwd)).toBe(join(first, "both.cmd"));
    expect(resolveForCmd("later", env, cwd)).toBe(join(second, "later.exe"));
    expect(resolveForCmd("here", env, cwd)).toBe(join(cwd, "here.cmd"));
    expect(resolveForCmd(join("bin", "nested"), env, cwd)).toBe(join(cwd, "bin", "nested.cmd"));
    expect(resolveForCmd(join(second, "tool.exe"), env, cwd)).toBe(join(second, "tool.exe"));
    expect(resolveForCmd("missing", env, cwd)).toBeNull();
    expect(resolveForCmd("tool", { PATHEXT: ".exe;.cmd" }, cwd)).toBeNull();
  });
});

// The script every command below ends in: it prints the arguments it received.
const echoArguments = "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n";
// An npm shim, as cmd-shim writes it: it hands its arguments to Node in a line cmd.exe reads again.
const shim = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\echo-arguments.js" %*',
  "",
].join("\r\n");

/** Arguments that cmd.exe or a program's own parsing would change if they weren't escaped. */
const awkward = [
  "plain",
  "",
  "two words",
  'say "hi"',
  "a&b",
  "a && b || c",
  "pipe | more",
  "<in >out 2>&1",
  "caret^up",
  "100%",
  "%PATH%",
  "%CLUBEDGE_TEST_VALUE%",
  "!CLUBEDGE_TEST_VALUE!",
  "(x86)",
  "semi;colon,comma=equals",
  "star*and?mark",
  "back`tick",
  "C:\\My Files\\",
  'a\\"b',
  'ends with a quote"',
  "--flag=value with spaces",
  "tab\there",
];

describe.runIf(process.platform === "win32")("commands on Windows", () => {
  /** A folder with the script, the shim that runs it, and a marker no command may create. */
  async function fixture(name = "tools") {
    const root = await temporaryDirectory();
    const folder = join(root, name);
    await writeFiles(folder, { "echo-arguments.js": echoArguments, "echo-arguments.cmd": shim });
    return { folder, script: join(folder, "echo-arguments.js"), marker: join(root, "injected.txt") };
  }
  // PATH under the name the environment already has it by, so there is one, with the fixture first.
  const pathName = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "Path";
  const environment = (folder: string) => ({
    ...process.env,
    [pathName]: [folder, process.env[pathName] ?? ""].join(delimiter),
    CLUBEDGE_TEST_VALUE: "expanded",
  });

  it("a batch file such as an npm shim receives every argument unchanged", async () => {
    const { folder } = await fixture();
    const output = await runCapture("echo-arguments", awkward, await temporaryDirectory(), environment(folder));
    expect(JSON.parse(output)).toEqual(awkward);
  });

  it("a batch file in a folder with spaces and parentheses runs by its name", async () => {
    const { folder } = await fixture("my tools (x86)");
    const output = await runCapture("echo-arguments", awkward, await temporaryDirectory(), environment(folder));
    expect(JSON.parse(output)).toEqual(awkward);
  });

  it("a program starts without cmd.exe and receives every argument unchanged, line breaks too", async () => {
    const { script } = await fixture();
    const args = [...awkward, "one\ntwo"];
    const output = await runCapture("node", [script, ...args], await temporaryDirectory(), environment(await temporaryDirectory()));
    expect(JSON.parse(output)).toEqual(args);
  });

  it("an argument can't start a second command", async () => {
    const { folder, script, marker } = await fixture();
    const attempts = [
      `x" & echo injected> "${marker}" & "`,
      `x & echo injected> "${marker}"`,
      `x | echo injected> "${marker}"`,
      `x" || echo injected> "${marker}" || "`,
      `x^" & echo injected> "${marker}" & ^"`,
    ];
    const cwd = await temporaryDirectory();
    expect(JSON.parse(await runCapture("echo-arguments", attempts, cwd, environment(folder)))).toEqual(attempts);
    expect(JSON.parse(await runCapture("node", [script, ...attempts], cwd, environment(folder)))).toEqual(attempts);
    expect(existsSync(marker)).toBe(false);
  });

  it("a batch file can't take an argument with a line break, and a missing command fails", async () => {
    const { folder } = await fixture();
    const cwd = await temporaryDirectory();
    expect(() => spawnCommand("echo-arguments", ["one\ntwo"], { cwd, env: environment(folder) })).toThrow(/line break/);
    await expect(runCapture("clubedge-no-such-command", ["--version"], cwd, environment(folder))).rejects.toThrow(/exited with code 1/);
  });
});

describe("runInto", () => {
  it("writes a command's output to the stream it is given", async () => {
    let written = "";
    const output = new Writable({
      write(chunk, _encoding, done) {
        written += String(chunk);
        done();
      },
    });
    await runInto(process.execPath, ["-e", "console.log('out'); console.error('err')"], process.cwd(), output);
    expect(written).toContain("out");
    expect(written).toContain("err");
  });

  it("stops the command and fails when the stream cannot be written, without ending the process", async () => {
    const output = new Writable({
      write(_chunk, _encoding, done) {
        done(new Error("disk full"));
      },
    });
    const run = runInto(
      process.execPath,
      ["-e", "setInterval(() => console.log('still running'), 20)"],
      process.cwd(),
      output,
    );
    await expect(run).rejects.toThrow("output could not be written: disk full");
  });
});
