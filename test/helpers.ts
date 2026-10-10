import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

export async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "create-clubedge-app-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

export const siteConfig = {
  name: "Clubedge Starter",
  shortName: "Clubedge",
  description: "A production-minded foundation for Clubedge applications.",
  serviceId: "clubedge-starter",
  workspaceLabel: "Starter workspace",
  links: { repository: "https://example.com/repo", setupGuide: "https://example.com/setup" },
};

export const manifest = {
  schemaVersion: 1,
  name: "clubedge-starter",
  packageManager: "pnpm",
  app: "apps/web",
  siteConfig: "apps/web/src/config/site.json",
  env: { example: ".env.example", target: "apps/web/.env.local" },
  dockerImage: "clubedge-starter",
  exclude: ["clubedge.template.json"],
};

/** A minimal Starter with the files the CLI reads or rewrites. */
export function starterFiles({ withManifest = true } = {}): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "clubedge-starter-v1",
      scripts: {
        "docker:build": "docker build -t clubedge-starter .",
        "docker:start": "docker run --rm -p 3000:3000 clubedge-starter",
      },
    }),
    "README.md": "# Clubedge Starter\n\nIntro.\n\n# Not a title\n",
    ".env.example": "DATABASE_URL=\n",
    ".gitignore": "node_modules/\n",
    "apps/web/src/config/site.json": JSON.stringify(siteConfig),
    "apps/web/src/app/page.tsx": "export default function Page() { return null; }\n",
    ...(withManifest ? { "clubedge.template.json": JSON.stringify(manifest) } : {}),
  };
}
