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

/** A schema 2 Starter offering Next.js (in place) and TanStack Start (in apps/start). */
export const frameworksManifest = {
  ...manifest,
  schemaVersion: 2,
  appPackage: "@clubedge/web",
  defaultFramework: "next",
  frameworks: {
    next: { name: "Next.js", app: "apps/web", envExample: ".env.example", dockerfile: "Dockerfile" },
    "tanstack-start": {
      name: "TanStack Start",
      app: "apps/start",
      envExample: "apps/start/.env.example",
      dockerfile: "apps/start/Dockerfile",
    },
  },
};

export const lockfile = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      turbo:
        specifier: ^2.5.0
        version: 2.5.0

  apps/start:
    dependencies:
      '@tanstack/react-start':
        specifier: 1.168.61
        version: 1.168.61

  apps/web:
    dependencies:
      next:
        specifier: ^16.1.0
        version: 16.1.0

  packages/core: {}

packages:

  next@16.1.0:
    resolution: {integrity: sha512-x}
`;

export function frameworkStarterFiles(): Record<string, string> {
  return {
    ...starterFiles({ withManifest: false }),
    "clubedge.template.json": JSON.stringify(frameworksManifest),
    "pnpm-lock.yaml": lockfile,
    Dockerfile: "FROM next\n",
    "apps/web/package.json": JSON.stringify({ name: "@clubedge/web" }),
    "apps/start/package.json": JSON.stringify({ name: "@clubedge/start" }),
    "apps/start/.env.example": "APP_URL=\n",
    "apps/start/.env.local": "SECRET=1\n",
    "apps/start/Dockerfile": "FROM start\n",
    "apps/start/src/config/site.json": JSON.stringify(siteConfig),
    "apps/start/src/routes/index.tsx": "export const Route = null;\n",
  };
}

/** A schema 3 Starter with auth and storage modules on top of the two frameworks. */
export const modulesManifest = {
  ...frameworksManifest,
  schemaVersion: 3,
  modules: {
    auth: {
      name: "Authentication",
      default: "supabase",
      options: {
        supabase: {
          name: "Supabase Auth",
          packages: { "@clubedge/auth-supabase": "packages/auth-supabase" },
          files: ["apps/web/src/app/login", "apps/start/src/routes/login.tsx"],
        },
        none: {
          name: "None",
          replace: {
            "apps/web/src/server/auth.ts": "apps/web/src/server/variants/auth.none.ts",
            "apps/start/src/server/auth.ts": "apps/start/src/server/variants/auth.none.ts",
          },
        },
      },
    },
    storage: {
      name: "File storage",
      default: "s3",
      options: {
        s3: {
          name: "S3-compatible",
          packages: { "@clubedge/storage-s3": "packages/storage-s3" },
          files: ["apps/web/src/server/storage.ts", "apps/start/src/server/storage.ts"],
        },
        supabase: {
          name: "Supabase Storage",
          packages: { "@clubedge/storage-supabase": "packages/storage-supabase" },
          files: ["apps/web/src/server/storage.ts", "apps/start/src/server/storage.ts"],
          replace: {
            "apps/web/src/server/storage.ts": "apps/web/src/server/variants/storage.supabase.ts",
            "apps/start/src/server/storage.ts": "apps/start/src/server/variants/storage.supabase.ts",
          },
          requires: { auth: "supabase" },
        },
        none: { name: "None" },
      },
    },
  },
  conditional: [".env.example", "apps/start/.env.example", "README.md"],
};

export const modulesLockfile = `lockfileVersion: '9.0'

importers:

  .: {}

  apps/start:
    dependencies:
      '@clubedge/auth-supabase':
        specifier: workspace:*
        version: link:../../packages/auth-supabase
      '@clubedge/storage-s3':
        specifier: workspace:*
        version: link:../../packages/storage-s3
      '@tanstack/react-start':
        specifier: 1.168.61
        version: 1.168.61

  apps/web:
    dependencies:
      '@clubedge/auth-supabase':
        specifier: workspace:*
        version: link:../../packages/auth-supabase
      next:
        specifier: ^16.1.0
        version: 16.1.0

  packages/auth-supabase:
    dependencies:
      '@supabase/ssr':
        specifier: ^0.6.1
        version: 0.6.1

  packages/storage-s3:
    dependencies:
      '@aws-sdk/client-s3':
        specifier: ^3.850.0
        version: 3.850.0

  packages/storage-supabase: {}

packages:

  next@16.1.0:
    resolution: {integrity: sha512-x}
`;

const envWithModules = (header: string) => `${header}
DATABASE_URL=

# clubedge:if auth=supabase
SUPABASE_URL=
# clubedge:end

# clubedge:if storage=s3
STORAGE_BUCKET=
# clubedge:end
`;

/**
 * A schema 6 Starter with stack packs: Next.js or a Vite frontend with an API, plus the apps
 * installed on devices, a native app (Expo) and a shell that packages the frontend (Capacitor).
 * Expo implements only some of the auth options.
 */
export function appStarterFiles(): Record<string, string> {
  const slot = (path: string, name: string, roles: string[], extra: Record<string, unknown> = {}) => ({
    name,
    question: `${name}?`,
    path,
    env: { example: `${path}/.env.example`, target: `${path}/.env.local` },
    roles,
    ...extra,
  });
  const root = {
    schemaVersion: 6,
    name: "clubedge-starter",
    packageManager: "pnpm",
    siteConfig: "apps/web/src/config/site.json",
    dockerImage: "clubedge-starter",
    slots: {
      framework: {
        ...slot("apps/web", "Framework", ["fullstack", "frontend"]),
        package: "@clubedge/web",
        env: { example: ".env.example", target: "apps/web/.env.local" },
        dockerfile: "Dockerfile",
        default: "next",
        optional: true,
      },
      api: {
        ...slot("apps/api", "API", ["api"]),
        package: "@clubedge/api",
        dockerfile: "apps/api/Dockerfile",
        siteConfig: "apps/api/src/config/site.json",
      },
      mobile: { ...slot("apps/mobile", "Mobile app", ["mobile"]), package: "@clubedge/mobile-app", siteConfig: "apps/mobile/src/config/site.json" },
      shell: { ...slot("apps/shell", "Mobile shell", ["shell"]), package: "@clubedge/shell" },
    },
    modules: ["auth", "deploy"],
    conditional: ["README.md", ".github/workflows/ci.yml"],
    exclude: ["clubedge.template.json"],
  };
  const everyAuth = { auth: { "better-auth|firebase|none": {} } };
  const stack = (data: Record<string, unknown>) => JSON.stringify({ envExample: ".env.example", ...data });
  const site = JSON.stringify(siteConfig);
  const importer = (name: string) => `    dependencies:\n      ${name}:\n        specifier: ^1.0.0\n        version: 1.0.0\n`;
  return {
    "clubedge.template.json": JSON.stringify(root),
    "clubedge/modules/auth.json": JSON.stringify({
      name: "Authentication",
      default: "better-auth",
      options: { "better-auth": { name: "Better Auth" }, firebase: { name: "Firebase Authentication" }, none: { name: "None" } },
    }),
    "clubedge/modules/deploy.json": JSON.stringify({ name: "Deployment", default: "docker", scope: "project", options: { docker: { name: "Docker" } } }),
    "apps/web/clubedge.stack.json": stack({ id: "next", name: "Next.js", role: "fullstack", envExample: "../../.env.example", dockerfile: "../../Dockerfile", modules: everyAuth }),
    "apps/vite/clubedge.stack.json": stack({ id: "vite", name: "React + Vite", role: "frontend", dockerfile: "Dockerfile", modules: everyAuth }),
    "apps/api/clubedge.stack.json": stack({ id: "hono", name: "Hono", role: "api", dockerfile: "Dockerfile", modules: everyAuth }),
    "apps/expo/clubedge.stack.json": stack({
      id: "expo",
      name: "Expo",
      role: "mobile",
      modules: { auth: { none: {}, "better-auth": { files: ["src/app/sign-in.tsx"] } } },
    }),
    "apps/capacitor/clubedge.stack.json": stack({ id: "capacitor", name: "Capacitor", role: "shell" }),
    "package.json": JSON.stringify({ name: "clubedge-starter", scripts: { dev: "turbo dev" } }),
    "README.md": "# Clubedge Starter\n\n<!-- clubedge:if mobile!=none -->\nThe native app.\n<!-- clubedge:end -->\n\nDone.\n",
    ".github/workflows/ci.yml": [
      "name: CI",
      "jobs:",
      "  web:",
      "    runs-on: ubuntu-latest",
      "# clubedge:if mobile!=none",
      "  expo:",
      "    runs-on: ubuntu-latest",
      "# clubedge:end",
      "# clubedge:if shell!=none",
      "  shell:",
      "    runs-on: ubuntu-latest",
      "# clubedge:end",
      "",
    ].join("\n"),
    "pnpm-lock.yaml": [
      "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n",
      `  apps/api:\n${importer("hono")}`,
      `  apps/capacitor:\n${importer("'@capacitor/core'")}`,
      `  apps/expo:\n${importer("expo")}`,
      `  apps/vite:\n${importer("vite")}`,
      `  apps/web:\n${importer("next")}`,
    ].join("\n"),
    ".env.example": "NEXT_PUBLIC_SITE_URL=\n",
    Dockerfile: "FROM node\n",
    "apps/web/package.json": JSON.stringify({ name: "@clubedge/web" }),
    "apps/web/src/config/site.json": site,
    "apps/vite/package.json": JSON.stringify({ name: "@clubedge/vite" }),
    "apps/vite/.env.example": "VITE_API_URL=\n",
    "apps/vite/Dockerfile": "FROM node\n",
    "apps/vite/src/config/site.json": site,
    "apps/api/package.json": JSON.stringify({ name: "@clubedge/api" }),
    "apps/api/.env.example": "DATABASE_URL=\n",
    "apps/api/Dockerfile": "FROM node\n",
    "apps/api/src/config/site.json": site,
    "apps/expo/package.json": JSON.stringify({ name: "@clubedge/expo" }),
    "apps/expo/.env.example": "EXPO_PUBLIC_API_URL=\n",
    "apps/expo/app.config.ts": "export default {};\n",
    "apps/expo/src/app/index.tsx": "export default function Home() { return null; }\n",
    "apps/expo/src/app/sign-in.tsx": "export default function SignIn() { return null; }\n",
    "apps/expo/src/config/site.json": site,
    "apps/capacitor/package.json": JSON.stringify({ name: "@clubedge/capacitor" }),
    "apps/capacitor/.env.example": "WEB_URL=\n",
    "apps/capacitor/capacitor.config.ts": "export default {};\n",
  };
}

export function moduleStarterFiles(): Record<string, string> {
  const appPackage = (name: string) =>
    JSON.stringify({
      name,
      dependencies: { "@clubedge/auth-supabase": "workspace:*", "@clubedge/storage-s3": "workspace:*" },
    });
  return {
    ...frameworkStarterFiles(),
    "clubedge.template.json": JSON.stringify(modulesManifest),
    "pnpm-lock.yaml": modulesLockfile,
    "README.md": "# Clubedge Starter\n\n<!-- clubedge:if auth=supabase -->\nSupabase setup.\n<!-- clubedge:end -->\n\nDone.\n",
    ".env.example": envWithModules("# next"),
    "apps/start/.env.example": envWithModules("# start"),
    "apps/web/package.json": appPackage("@clubedge/web"),
    "apps/start/package.json": appPackage("@clubedge/start"),
    "apps/web/src/app/login/page.tsx": "export default function Login() { return null; }\n",
    "apps/web/src/server/auth.ts": "export const provider = 'supabase';\n",
    "apps/web/src/server/variants/auth.none.ts": "export const provider = 'none';\n",
    "apps/web/src/server/storage.ts": "export const storage = 's3';\n",
    "apps/web/src/server/variants/storage.supabase.ts": "export const storage = 'supabase';\n",
    "apps/start/src/routes/login.tsx": "export const Route = null;\n",
    "apps/start/src/server/auth.ts": "export const provider = 'supabase';\n",
    "apps/start/src/server/variants/auth.none.ts": "export const provider = 'none';\n",
    "apps/start/src/server/storage.ts": "export const storage = 's3';\n",
    "apps/start/src/server/variants/storage.supabase.ts": "export const storage = 'supabase';\n",
    "packages/auth-supabase/package.json": JSON.stringify({ name: "@clubedge/auth-supabase" }),
    "packages/storage-s3/package.json": JSON.stringify({ name: "@clubedge/storage-s3" }),
    "packages/storage-supabase/package.json": JSON.stringify({ name: "@clubedge/storage-supabase" }),
  };
}
