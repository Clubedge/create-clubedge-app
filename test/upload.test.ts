import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli/args.js";
import { projectTryProblem, remoteName } from "../src/core/railway.js";
import { isUploadable, uploadableFiles } from "../src/core/upload.js";
import { openCommand } from "../src/utils/open.js";
import { createTarGz } from "../src/utils/tar.js";

const temporary: string[] = [];
function folder(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "clubedge-upload-"));
  temporary.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("what try uploads", () => {
  it("leaves out env files, installed and built output", () => {
    expect(isUploadable("apps/web/src/page.tsx")).toBe(true);
    expect(isUploadable("apps/web/.env.example")).toBe(true);
    expect(isUploadable(".env.example")).toBe(true);
    expect(isUploadable("apps/web/.env.local")).toBe(false);
    expect(isUploadable(".env")).toBe(false);
    expect(isUploadable(".env.production")).toBe(false);
    expect(isUploadable("node_modules/x/index.js")).toBe(false);
    expect(isUploadable("apps/web/.next/server.js")).toBe(false);
    expect(isUploadable(".data/pglite/base")).toBe(false);
    expect(isUploadable(".git/config")).toBe(false);
  });

  it("walks a folder outside Git", async () => {
    const root = folder({
      "package.json": "{}",
      "apps/web/.env.local": "SECRET=1",
      "apps/web/.env.example": "SECRET=",
      "node_modules/a/index.js": "",
      "src/index.ts": "",
    });
    // A fresh temp folder is not inside a Git repository, so this takes the walking path.
    expect(await uploadableFiles(root)).toEqual(["apps/web/.env.example", "package.json", "src/index.ts"]);
  });

  const hasGit = spawnSync("git", ["--version"]).status === 0;
  it.skipIf(!hasGit)("follows .gitignore in a Git repository", async () => {
    const root = folder({
      ".gitignore": "ignored.txt\n",
      "package.json": "{}",
      "ignored.txt": "x",
      "kept.txt": "x",
      ".env": "SECRET=1",
    });
    spawnSync("git", ["init", "-q"], { cwd: root });
    expect(await uploadableFiles(root)).toEqual([".gitignore", "kept.txt", "package.json"]);
  });
});

describe("upload archive", () => {
  const hasTar = spawnSync("tar", ["--version"]).status === 0;
  it.skipIf(!hasTar)("unpacks with tar, long paths included", async () => {
    const long = `${"deep/".repeat(30)}file.txt`;
    const root = folder({ "package.json": '{"name":"x"}', [long]: "deep content", "a b/c.txt": "spaced" });
    const { archive, files, bytes } = await createTarGz(root, ["package.json", long, "a b/c.txt", "missing.txt"]);
    expect(files).toBe(3);
    expect(bytes).toBe(12 + 12 + 6);

    const out = mkdtempSync(join(tmpdir(), "clubedge-untar-"));
    temporary.push(out);
    const archivePath = join(out, "upload.tgz");
    writeFileSync(archivePath, archive);
    const result = spawnSync("tar", ["xzf", "upload.tgz"], { cwd: out, encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(readFileSync(join(out, long), "utf8")).toBe("deep content");
    expect(readFileSync(join(out, "a b/c.txt"), "utf8")).toBe("spaced");
    expect(readFileSync(join(out, "package.json"), "utf8")).toBe('{"name":"x"}');
  });
});

describe("try inside a project", () => {
  it("runs projects without Docker", () => {
    expect(projectTryProblem({ infra: "local", auth: "better-auth" })).toBeNull();
    expect(projectTryProblem({ infra: "none", auth: "none" })).toBeNull();
    expect(projectTryProblem({ infra: "docker" })).toMatch(/add infra local/);
    expect(projectTryProblem({ infra: "local", auth: "supabase" })).toMatch(/add auth better-auth/);
  });

  it("names the directory on the VM after the package", () => {
    expect(remoteName("@acme/web")).toBe("web");
    expect(remoteName("My App!")).toBe("my-app");
    expect(remoteName("---")).toBe("my-app");
  });
});

describe("opening the preview", () => {
  it("uses each platform's opener", () => {
    expect(openCommand("https://x.dev", "darwin")).toEqual(["open", ["https://x.dev"]]);
    expect(openCommand("https://x.dev", "linux")).toEqual(["xdg-open", ["https://x.dev"]]);
    expect(openCommand("https://x.dev", "win32")[0]).toBe("rundll32");
  });

  it("can be turned off", () => {
    expect(parseCliArgs(["try"]).open).toBe(true);
    expect(parseCliArgs(["try", "--no-open"]).open).toBe(false);
  });
});
