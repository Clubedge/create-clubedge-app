import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectPnpm } from "../src/steps/install.js";
import { onPath } from "../src/utils/process.js";
import { temporaryDirectory, writeFiles } from "./helpers.js";

/** Like pnpm: fails when the package.json of the folder it runs in does not parse. */
const pnpmLike = `const fs = require("node:fs");
try {
  if (fs.existsSync("package.json")) JSON.parse(fs.readFileSync("package.json", "utf8"));
} catch {
  console.error(" ERROR  package.json does not parse");
  process.exit(1);
}
console.log("10.9.0");
`;

/** A PATH folder with a `pnpm` that runs the script with this Node. */
async function binWithPnpm(script: string) {
  const bin = await temporaryDirectory();
  const entry = join(bin, "pnpm.js");
  await writeFile(entry, script);
  if (process.platform === "win32") {
    await writeFile(join(bin, "pnpm.cmd"), `@"${process.execPath}" "${entry}" %*\r\n`);
  } else {
    await writeFile(join(bin, "pnpm"), `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`);
    await chmod(join(bin, "pnpm"), 0o755);
  }
  return bin;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("detectPnpm", () => {
  it("finds pnpm while the project's package.json has conflict markers", async () => {
    const project = await temporaryDirectory();
    await writeFiles(project, {
      "package.json": '{\n<<<<<<< yours\n  "version": "1.0.0",\n=======\n  "version": "0.25.0",\n>>>>>>> clubedge\n}\n',
    });
    vi.stubEnv("PATH", await binWithPnpm(pnpmLike));
    const cwd = process.cwd();
    process.chdir(project);
    try {
      expect(await detectPnpm()).toEqual({ pnpm: ["pnpm"] });
    } finally {
      process.chdir(cwd);
    }
  });

  it("reports a pnpm that is installed but fails, instead of a missing one", async () => {
    vi.stubEnv("PATH", await binWithPnpm('console.error("broken install"); process.exit(1);\n'));
    const detected = await detectPnpm();
    expect(detected.pnpm).toBeNull();
    expect(detected.problem).toMatch(/^`pnpm --version` failed: pnpm exited with code 1: broken install\.$/);
  });

  it("reports pnpm missing when neither pnpm nor corepack is installed", async () => {
    vi.stubEnv("PATH", await temporaryDirectory());
    expect(await detectPnpm()).toEqual({ pnpm: null, problem: undefined });
  });
});

describe("onPath", () => {
  it("finds a command in a PATH folder, with PATHEXT's extensions on Windows", async () => {
    const bin = await binWithPnpm(pnpmLike);
    const env = { PATH: [await temporaryDirectory(), bin].join(process.platform === "win32" ? ";" : ":"), PATHEXT: ".EXE;.CMD" };
    expect(await onPath("pnpm", env)).toBe(true);
    expect(await onPath("corepack", env)).toBe(false);
    expect(await onPath("pnpm", { PATH: "" })).toBe(false);
  });
});
