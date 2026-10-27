// add and remove for the apps installed on devices, the native app and the shell, which a project
// can take or drop after it was created. pnpm and the terminal output are replaced, so nothing is
// installed and the messages can be read.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { log, multiselect } from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "../src/cli/args.js";
import { executePlan } from "../src/core/execute.js";
import { readTemplateManifest } from "../src/core/manifest.js";
import { createPlan } from "../src/core/plan.js";
import { readProject } from "../src/core/project.js";
import { readDirectoryTemplate } from "../src/core/source.js";
import { appSlots, changeProject, completeCommand } from "../src/modify.js";
import { detectPnpm, installDependencies } from "../src/steps/install.js";
import { pathExists } from "../src/utils/fs.js";
import { appStarterFiles, temporaryDirectory, writeFiles } from "./helpers.js";

vi.mock("../src/steps/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/steps/install.js")>()),
  detectPnpm: vi.fn(),
  installDependencies: vi.fn(),
}));

const spinnerStart = vi.fn();

vi.mock("@clack/prompts", async (importOriginal) => {
  const prompts = await importOriginal<typeof import("@clack/prompts")>();
  return {
    ...prompts,
    intro: vi.fn(),
    outro: vi.fn(),
    multiselect: vi.fn(),
    spinner: () => ({ start: spinnerStart, stop: vi.fn(), message: vi.fn() }),
    log: { info: vi.fn(), warn: vi.fn(), success: vi.fn(), message: vi.fn(), error: vi.fn(), step: vi.fn() },
  };
});

/** A project generated from the apps fixture, and a function that runs a command in it. */
async function generatedProject(stacks: Record<string, string>, modules: Record<string, string> = {}) {
  const starter = await temporaryDirectory();
  await writeFiles(starter, appStarterFiles());
  const source = await readDirectoryTemplate(starter);
  const manifest = await readTemplateManifest(source.root);
  const root = join(await temporaryDirectory(), "my-product");
  await executePlan(
    createPlan({
      targetDirectory: root,
      identity: { packageName: "my-product", displayName: "My Product" },
      source,
      manifest,
      stacks,
      modules,
      cliVersion: "1.0.0",
      git: false,
      install: false,
    }),
    source,
  );
  const argv = (command: string[]) => [...command, "--template-dir", starter, "--force", "--yes"];
  return {
    root,
    manifest,
    run: (command: string[]) => {
      vi.spyOn(process, "cwd").mockReturnValue(root);
      return changeProject(parseCliArgs(argv(command)));
    },
    read: (path: string) => readFile(join(root, path), "utf8"),
    write: async (path: string, content: string) => {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    },
    exists: (path: string) => pathExists(join(root, path)),
  };
}

const infos = () => vi.mocked(log.info).mock.calls.map(([message]) => message);
const website = { framework: "vite", api: "hono" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(detectPnpm).mockResolvedValue({ pnpm: ["pnpm"] });
  vi.mocked(installDependencies).mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("adding and removing the native app", () => {
  it("adds its files, its env file, its CI job, its dependencies, and the record of it", async () => {
    const project = await generatedProject(website);
    expect(await project.run(["add", "mobile", "expo"])).toBe("changed");

    expect(JSON.parse(await project.read("apps/mobile/package.json")).name).toBe("@clubedge/mobile-app");
    expect(JSON.parse(await project.read("apps/mobile/src/config/site.json")).name).toBe("My Product");
    expect(await project.exists("apps/mobile/src/app/sign-in.tsx")).toBe(true);
    // Created from its example, as a new project's is.
    expect(await project.read("apps/mobile/.env.local")).toBe("EXPO_PUBLIC_API_URL=\n");
    expect(await project.read(".github/workflows/ci.yml")).toContain("  expo:\n");
    expect(await project.read("README.md")).toContain("The native app.");
    expect(await project.read("pnpm-lock.yaml")).toContain("  apps/mobile:\n");
    expect(installDependencies).toHaveBeenCalledOnce();

    expect(JSON.parse(await project.read("package.json")).clubedge.apps).toEqual({ api: "hono", mobile: "expo" });
    expect((await readProject(project.root)).stacks).toEqual({ ...website, mobile: "expo" });
    expect(infos()).toContainEqual(expect.stringContaining("Expo is in apps/mobile, with its settings in apps/mobile/.env.local."));
  });

  it("removes them again, and leaves what was never the Starter's", async () => {
    const project = await generatedProject({ ...website, mobile: "expo" });
    await project.write("apps/mobile/.env.local", "EXPO_PUBLIC_API_URL=https://api.example.com\n");
    await project.write("apps/mobile/node_modules/expo/package.json", "{}");

    expect(await project.run(["remove", "mobile"])).toBe("changed");
    expect(await project.exists("apps/mobile/package.json")).toBe(false);
    expect(await project.exists("apps/mobile/src")).toBe(false);
    expect(await project.read("apps/mobile/.env.local")).toBe("EXPO_PUBLIC_API_URL=https://api.example.com\n");
    expect(await project.read(".github/workflows/ci.yml")).not.toContain("expo");
    expect(await project.read("pnpm-lock.yaml")).not.toContain("apps/mobile");
    expect(JSON.parse(await project.read("package.json")).clubedge.apps).toEqual({ api: "hono" });
    expect(infos()).toContainEqual(expect.stringContaining("apps/mobile still holds what was never the Starter's (.env.local, node_modules)"));
  });

  it("adds it with an auth option it implements, switched in the same command", async () => {
    const project = await generatedProject(website, { auth: "firebase" });
    await expect(project.run(["add", "mobile", "expo"])).rejects.toThrow(
      "Expo does not implement Firebase Authentication (auth firebase). It implements: better-auth, none. " +
        "Switch it in the same command, for example: pnpm dlx @clubedge/create-clubedge-app add mobile expo auth better-auth",
    );
    expect(await project.exists("apps/mobile")).toBe(false);

    expect(await project.run(["add", "mobile", "expo", "auth", "better-auth"])).toBe("changed");
    expect(JSON.parse(await project.read("package.json")).clubedge).toMatchObject({
      apps: { mobile: "expo" },
      modules: { auth: "better-auth" },
    });
  });

  it("refuses a project without an API, and says which project can have the native app", async () => {
    const project = await generatedProject({ framework: "next" });
    await expect(project.run(["add", "mobile", "expo"])).rejects.toThrow(
      "Expo calls the project's API, and this project has none: Next.js serves its own pages. " +
        "A project's framework and API are chosen when it is created, so add cannot change them: " +
        "for Expo, create a project with --framework vite or none, and --api hono.",
    );
  });

  it("does nothing for an app the project already has, without preparing the Starter", async () => {
    const project = await generatedProject({ ...website, mobile: "expo" });
    expect(await project.run(["add", "mobile", "expo"])).toBe("unchanged");
    expect(spinnerStart).not.toHaveBeenCalled();
  });

  it("names the stacks a slot offers", async () => {
    const project = await generatedProject(website);
    await expect(project.run(["add", "mobile", "flutter"])).rejects.toThrow('Unknown mobile app "flutter". Choose one of: expo.');
  });
});

describe("adding and removing the shell", () => {
  it("packages the frontend, then leaves it out again", async () => {
    const project = await generatedProject(website);
    expect(await project.run(["add", "shell", "capacitor"])).toBe("changed");
    expect(JSON.parse(await project.read("apps/shell/package.json")).name).toBe("@clubedge/shell");
    expect(await project.read("apps/shell/.env.local")).toBe("WEB_URL=\n");
    expect(await project.read(".github/workflows/ci.yml")).toContain("  shell:\n");
    expect(JSON.parse(await project.read("package.json")).clubedge.apps).toEqual({ api: "hono", shell: "capacitor" });

    // The native projects Capacitor creates are the developer's, and stay.
    await project.write("apps/shell/android/app/build.gradle", "android {}\n");
    expect(await project.run(["remove", "shell"])).toBe("changed");
    expect(await project.exists("apps/shell/capacitor.config.ts")).toBe(false);
    expect(await project.exists("apps/shell/android/app/build.gradle")).toBe(true);
    expect(JSON.parse(await project.read("package.json")).clubedge.apps).toEqual({ api: "hono" });
    expect(infos()).toContainEqual(expect.stringContaining("apps/shell still holds what was never the Starter's (.env.local, android)"));
  });

  it("refuses a full-stack framework, which renders its pages on its server", async () => {
    const project = await generatedProject({ framework: "next" });
    await expect(project.run(["add", "shell", "capacitor"])).rejects.toThrow(
      "Capacitor packages a frontend's static files, and Next.js renders its pages on its server. " +
        "A project's framework and API are chosen when it is created, so add cannot change them: " +
        "for Capacitor, create a project with --framework vite.",
    );
  });

  it("goes in the same command as the native app", async () => {
    const project = await generatedProject(website);
    expect(await project.run(["add", "mobile", "expo", "shell", "capacitor"])).toBe("changed");
    expect(JSON.parse(await project.read("package.json")).clubedge.apps).toEqual({ api: "hono", mobile: "expo", shell: "capacitor" });
    expect(await project.run(["remove", "mobile", "shell"])).toBe("changed");
    expect(JSON.parse(await project.read("package.json")).clubedge.apps).toEqual({ api: "hono" });
  });
});

describe("the apps add and remove change", () => {
  it("are those installed on devices: the framework and the API stay as created", async () => {
    const project = await generatedProject(website);
    expect(appSlots(project.manifest)).toEqual(["mobile", "shell"]);
    await expect(project.run(["add", "framework", "next"])).rejects.toThrow(
      "The framework is chosen when a project is created: add and remove change modules and the apps installed on devices (mobile, shell).",
    );
    await expect(project.run(["remove", "api"])).rejects.toThrow("The API is chosen when a project is created");
  });

  it("are offered by an interactive add, which picks the only stack that fits", async () => {
    const project = await generatedProject(website);
    const read = await readProject(project.root);
    vi.mocked(multiselect).mockResolvedValue(["mobile"]);

    await expect(completeCommand(project.manifest, read, { name: "add", changes: [] }, true)).resolves.toEqual({
      name: "add",
      changes: [{ module: "mobile", option: "expo" }],
    });
    const offered = vi.mocked(multiselect).mock.calls[0]![0].options.map(({ value }) => value);
    expect(offered).toEqual(["mobile", "shell", "auth", "deploy"]);
  });
});
