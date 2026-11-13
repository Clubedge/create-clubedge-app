// Templates of your own: a fork of the Starter on GitHub, often private, that projects are made
// from and upgrade within. GitHub's downloads (giget) and Git are stand-ins here, which serve two
// releases of the modules fixture.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadTemplate } from "giget";
import { parseCliArgs } from "../src/cli/args.js";
import { executePlan } from "../src/core/execute.js";
import { readTemplateManifest } from "../src/core/manifest.js";
import { createPlan } from "../src/core/plan.js";
import {
  isPinnedStarter,
  latestReleaseTag,
  readDirectoryTemplate,
  resolveTemplateSource,
  templateToken,
} from "../src/core/source.js";
import { changeProject } from "../src/modify.js";
import { starterPin } from "../src/package-info.js";
import { projectEnv } from "../src/steps/install.js";
import { runCapture } from "../src/utils/process.js";
import { moduleStarterFiles, temporaryDirectory, writeFiles } from "./helpers.js";

vi.mock("giget", () => ({ downloadTemplate: vi.fn() }));
vi.mock("../src/utils/process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/process.js")>()),
  runCapture: vi.fn(),
}));

const TEMPLATE = "acme/acme-starter";
const commitOf = (ref: string) => (ref === "v2.0.0" ? "2" : "1").repeat(40);

/** The template's two releases: v2.0.0 adds a file. */
function release(ref: string): Record<string, string> {
  const files = moduleStarterFiles();
  return ref === "v2.0.0" || ref === commitOf("v2.0.0")
    ? { ...files, "apps/web/src/server/health.ts": "export const healthy = true;\n" }
    : files;
}

beforeEach(() => {
  vi.mocked(downloadTemplate).mockImplementation(async (input, options) => {
    const ref = String(input).split("#")[1]!;
    await writeFiles(options!.dir!, release(ref));
    return { dir: options!.dir!, source: String(input) } as Awaited<ReturnType<typeof downloadTemplate>>;
  });
  vi.mocked(runCapture).mockImplementation(async (command, args) => {
    if (command === "git" && args.includes("ls-remote")) {
      return `${commitOf("v1.0.0")}\trefs/tags/v1.0.0\n${commitOf("v2.0.0")}\trefs/tags/v2.0.0`;
    }
    if (command === "git") throw new Error("not a repository");
    return "";
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
    String(url).endsWith(`/repos/${TEMPLATE}/releases/latest`)
      ? Response.json({ tag_name: "v2.0.0" })
      : Response.json([]),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("a template's token", () => {
  it("is CLUBEDGE_TEMPLATE_TOKEN, else GITHUB_TOKEN or GH_TOKEN", () => {
    expect(templateToken({ CLUBEDGE_TEMPLATE_TOKEN: "t", GITHUB_TOKEN: "g" })).toBe("t");
    expect(templateToken({ GITHUB_TOKEN: "g", GH_TOKEN: "h" })).toBe("g");
    expect(templateToken({ GH_TOKEN: "h" })).toBe("h");
    expect(templateToken({})).toBeUndefined();
  });

  it("never reaches the commands the CLI runs in a project, such as pnpm", () => {
    expect(projectEnv({ PATH: "/bin", CLUBEDGE_TEMPLATE_TOKEN: "secret", GITHUB_TOKEN: "g" })).toEqual({
      PATH: "/bin",
      GITHUB_TOKEN: "g",
    });
  });
});

describe("a template of your own", () => {
  it("is anything but the Starter this CLI is pinned to", () => {
    expect(isPinnedStarter(undefined)).toBe(true);
    expect(isPinnedStarter(starterPin.starterRepository.toUpperCase())).toBe(true);
    expect(isPinnedStarter(TEMPLATE)).toBe(false);
  });

  it("creates from its newest release, read with the token", async () => {
    vi.stubEnv("CLUBEDGE_TEMPLATE_TOKEN", "template-token");
    const source = await resolveTemplateSource({ repository: TEMPLATE });
    try {
      expect(source).toMatchObject({ kind: "github", repository: TEMPLATE, ref: "v2.0.0", commit: commitOf("v2.0.0") });
      // The tag's commit, resolved first, so the files are that commit's.
      expect(downloadTemplate).toHaveBeenCalledWith(`gh:${TEMPLATE}#${commitOf("v2.0.0")}`, expect.objectContaining({ auth: "template-token" }));
      // Git resolves the ref with the token as a header, written nowhere.
      const gitArgs = vi.mocked(runCapture).mock.calls.find(([, args]) => args.includes("ls-remote"))![1];
      expect(gitArgs.slice(0, 2)).toEqual([
        "-c",
        `http.extraHeader=Authorization: Basic ${Buffer.from("x-access-token:template-token").toString("base64")}`,
      ]);
      const [, init] = vi.mocked(fetch).mock.calls[0]!;
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer template-token");
    } finally {
      await source.cleanup();
    }
  });

  it("says what to do when it has no release, or the token cannot read it", async () => {
    for (const name of ["CLUBEDGE_TEMPLATE_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"]) vi.stubEnv(name, "");
    await expect(latestReleaseTag(TEMPLATE, async () => new Response("", { status: 404 }))).rejects.toThrow(
      `${TEMPLATE} has no published release, or this token cannot read it: pass --ref with one of its tags or branches, and CLUBEDGE_TEMPLATE_TOKEN for a private repository.`,
    );
  });

  it("upgrades a project made from it to its newest release, within the template", async () => {
    vi.stubEnv("CLUBEDGE_TEMPLATE_TOKEN", "template-token");
    const folder = await temporaryDirectory();
    await writeFiles(folder, release("v1.0.0"));
    const v1 = { ...(await readDirectoryTemplate(folder)), kind: "github" as const, repository: TEMPLATE, ref: "v1.0.0", commit: commitOf("v1.0.0") };
    const root = join(await temporaryDirectory(), "my-product");
    await executePlan(
      createPlan({
        targetDirectory: root,
        identity: { packageName: "my-product", displayName: "My Product" },
        source: v1,
        manifest: await readTemplateManifest(v1.root),
        stacks: { framework: "next" },
        modules: {},
        cliVersion: "1.0.0",
        git: false,
        install: false,
      }),
      v1,
    );

    const outcome = await changeProject(parseCliArgs(["upgrade", "--force", "--yes", "--no-install"]), { root, output: process.stderr });

    expect(outcome).toBe("changed");
    // The project's own release, by commit, and the template's newest, both from the template.
    expect(vi.mocked(downloadTemplate).mock.calls.map(([input]) => input)).toEqual([
      `gh:${TEMPLATE}#${commitOf("v1.0.0")}`,
      `gh:${TEMPLATE}#${commitOf("v2.0.0")}`,
    ]);
    const record = JSON.parse(await readFile(join(root, "package.json"), "utf8")).clubedge;
    expect(record).toMatchObject({ starterRepository: TEMPLATE, starterRef: "v2.0.0", starterCommit: commitOf("v2.0.0") });
    expect(await readFile(join(root, "apps/web/src/server/health.ts"), "utf8")).toBe("export const healthy = true;\n");
  });
});
