<div align="center">

<img src="https://raw.githubusercontent.com/Clubedge/create-clubedge-app/main/.github/assets/cover.png" alt="Terminal running pnpm dlx @clubedge/create-clubedge-app my-app and printing the CLUBEDGE STARTER banner" width="100%">

# create-clubedge-app

**Create a production-ready React app with one command: Next.js, TanStack Start, or Vite with a separate API.**

Pick only the modules you need: auth, storage, email, payments, jobs, observability, deployment.<br>
Add, remove, or upgrade them later without losing your own changes.

[![npm](https://img.shields.io/npm/v/@clubedge/create-clubedge-app?style=flat-square)](https://www.npmjs.com/package/@clubedge/create-clubedge-app)
[![npm downloads](https://img.shields.io/npm/dm/@clubedge/create-clubedge-app?style=flat-square)](https://www.npmjs.com/package/@clubedge/create-clubedge-app)
[![CI](https://img.shields.io/github/actions/workflow/status/Clubedge/create-clubedge-app/ci.yml?branch=main&label=CI&style=flat-square)](https://github.com/Clubedge/create-clubedge-app/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Clubedge/create-clubedge-app?style=flat-square)](https://github.com/Clubedge/create-clubedge-app/releases)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)

[Website](https://starter.clubedge.live) ·
[Clubedge Starter](https://github.com/Clubedge/clubedge-starter) ·
[Changelog](CHANGELOG.md) ·
[Roadmap](ROADMAP.md) ·
[Contributing](CONTRIBUTING.md)

</div>

```sh
pnpm dlx @clubedge/create-clubedge-app my-app
```

## MCP server

Coding agents can connect to a local MCP server to inspect the capabilities of this CLI's pinned Starter release, validate stack and module choices, preview a complete scaffold plan, and generate a project in the server's working directory. The server exposes `get_starter_capabilities`, `validate_project_config`, `plan_project`, and `create_project`. Planning and validation do not write files. Project creation does not initialize Git or install dependencies unless those options are requested, and makes no network calls of its own: with `infra: neon`, `plan_project` lists `pnpm clubedge neon create` as a next step and `create_project` returns it as a warning, since the database is left for you to create.

Run it from the workspace where projects should be created:

```sh
npx -y --package @clubedge/create-clubedge-app create-clubedge-app-mcp
```

Configure an MCP client to launch `npx -y --package @clubedge/create-clubedge-app create-clubedge-app-mcp` with its working directory set to the workspace. In Codex, add this to `~/.codex/config.toml` and replace the example with the absolute path of the workspace where projects should be created:

```toml
[mcp_servers.clubedge-starter]
command = "npx"
args = ["--yes", "--package", "@clubedge/create-clubedge-app", "create-clubedge-app-mcp"]
cwd = "D:/path/to/workspace"
```

The MCP server is included in the same package and uses the CLI's bundled Starter and compatibility rules. Its create tool only writes beneath the configured working directory and refuses a non-empty destination.

### Agent skill

The npm package includes the Agent Skill at [`skills/clubedge-starter/SKILL.md`](skills/clubedge-starter/SKILL.md). Download and extract the package in PowerShell:

```powershell
$skillTarball = npm pack @clubedge/create-clubedge-app@latest
tar -xzf $skillTarball
```

Then install it for the current user:

```powershell
# Codex
New-Item -ItemType Directory -Force "$HOME/.agents/skills/clubedge-starter" | Out-Null
Copy-Item .\package\skills\clubedge-starter\SKILL.md "$HOME/.agents/skills/clubedge-starter/SKILL.md"

# Claude Code
New-Item -ItemType Directory -Force "$HOME/.claude/skills/clubedge-starter" | Out-Null
Copy-Item .\package\skills\clubedge-starter\SKILL.md "$HOME/.claude/skills/clubedge-starter/SKILL.md"
```

These commands create `package/` in the current directory. Remove that extracted folder and tarball when the copy is done. From a clone of this repository, the same copy commands work with `skills/...` instead of `package/skills/...`.

For a repository-only install, use `.agents/skills/clubedge-starter/` for Codex or `.claude/skills/clubedge-starter/` for Claude Code instead of the `$HOME` paths. Restart the agent session after installing. In Codex, ask it to `Use the clubedge-starter skill to inspect the available stacks and modules. Do not create a project.` In Claude Code, invoke `/clubedge-starter` and give it the same request. The skill uses live MCP capabilities when available, so its choices follow the Starter release installed with the server.

To connect the MCP server in Claude Code, run this from the workspace where projects should be created:

```sh
claude mcp add --scope local --transport stdio clubedge-starter -- npx -y --package @clubedge/create-clubedge-app create-clubedge-app-mcp
claude mcp get clubedge-starter
```

Then open Claude Code in that workspace, invoke `/clubedge-starter`, and ask it to inspect the available stacks and modules without creating a project. In Codex, use the `cwd` in `~/.codex/config.toml` above, restart Codex, and ask the same prompt. To exercise project creation, ask the agent to create a named project in a new child folder with Git and dependency installation disabled; verify the folder and report before enabling those optional actions.

## Why create-clubedge-app

Copying a starter is easy; living with it is not. You delete the services you don't use by hand, and once you've changed the code, every later improvement to the starter has to be copied over by hand too.

create-clubedge-app generates a project from a tested release of [Clubedge Starter](https://github.com/Clubedge/clubedge-starter) with only the modules you choose. A module you leave out is removed completely: its package, its provider SDK, its environment variables, its documentation, and its lockfile entries. The project records exactly what it was generated from, so later the CLI can add a module, remove one, or upgrade to a newer Starter release by merging the change into your code. Files you never touched are updated; your edits are kept.

Every CLI release is pinned to one Starter release and verified against it, so the same command always produces the same project.

## Quick start

You need Node.js 22.12 or newer and pnpm 10.9.0 or newer. Git is used for the default repository initialization.

```sh
pnpm dlx @clubedge/create-clubedge-app my-app
cd my-app
pnpm dev
```

Or start it with npm: `npx @clubedge/create-clubedge-app my-app`. The generated project is a pnpm workspace, so dependencies are installed with pnpm either way; the CLI falls back to `corepack pnpm` when `pnpm` is not on your path. Without a destination, the CLI asks where to create the project.

The generated project includes `apps/web/.env.local` (and `apps/api/.env.local` with a separate API), created from the example and pointing at the local services you chose. Its `SETUP.md` describes every variable and provider. The root route is a landing page named after your project, and the dashboard is at `/dashboard`.

The default Starter release ships inside the CLI package, so GitHub is only contacted when you pass `--ref`. Internet access is needed to install dependencies.

## Choosing a framework

For full-stack apps, the Starter ships the same application for Next.js and TanStack Start. Next.js is the default; pick TanStack Start with `--framework`, or choose interactively:

```sh
pnpm dlx @clubedge/create-clubedge-app my-app --framework tanstack-start
```

| `--framework`    | App                         | Production output             |
| ---------------- | --------------------------- | ----------------------------- |
| `next`           | Next.js App Router          | Next.js standalone build      |
| `tanstack-start` | TanStack Start with Vite    | Nitro `.output` server bundle |

Either way, the app lives in `apps/web` and uses the same shared packages, so the project layout, root scripts, and Docker commands are identical.

### A frontend and a separate API

A frontend can instead call a separate API, so the API can be written in another language later:

```sh
pnpm dlx @clubedge/create-clubedge-app my-app --framework vite --api hono
```

| Flag               | App                                                   | Where       |
| ------------------ | ----------------------------------------------------- | ----------- |
| `--framework vite` | React + Vite single-page app (TanStack Router)        | `apps/web`  |
| `--api hono`       | Hono API on Node, reusing the Starter's packages      | `apps/api`  |
| `--api fastapi`    | FastAPI API in Python, managed with [uv](https://docs.astral.sh/uv/) | `apps/api`  |

A Python API needs uv; the CLI installs its dependencies with it after `pnpm install`, and its `package.json` scripts call uv, so `pnpm dev`, `pnpm lint`, and `pnpm test` run it like the other apps.

They meet at one HTTP contract, `packages/contract/openapi.yaml`: the frontend calls the API only through the client generated from it, and every API passes the same conformance suite. `pnpm dev` starts both, and the frontend forwards `/api` to the API. A full-stack framework (`next`, `tanstack-start`) has its own server, so it takes no `--api`.

With `--auth supabase`, the Vite app owns the browser session and attaches its access token to contract requests. Hono or FastAPI verifies that token with Supabase Auth and returns the contract's shared user shape. Configure `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`, and `SUPABASE_PUBLISHABLE_KEY` in the generated env examples; no Supabase service-role key goes to the browser.

With the Hono API, the decoupled stacks support every module option the full-stack frameworks do (since Starter v0.26.0), each running in the API with the matching UI in the frontend; with FastAPI, they support Supabase Auth, Better Auth, Firebase, Appwrite, or `none`, plus memory cache. Both work with any local infrastructure (the API's `apps/api/.env.local` holds `DATABASE_URL`, since the API owns the database), and Docker or Railway deployment. With Docker, `pnpm clubedge deploy` writes a `compose.yaml` that builds the frontend and API as separate services; copy the variables of `.env.example` and `apps/api/.env.example` to `.env.production`, fill in their values, and run `docker compose --env-file .env.production up --build -d`. The frontend's `VITE_*` values are build arguments, compiled into its bundle; with Better Auth, its Node server also gets the auth variables (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, and the email settings). With Railway, deploy provisions a public frontend and a private API, wires the frontend proxy to the API, and runs migrations before releasing the API. See [docs/stack-packs.md](docs/stack-packs.md) for how stacks and deployment facts are described.

## Choosing modules

Authentication, file storage, caching, email, payments, background jobs, observability, local infrastructure, and deployment are modules. Each has a default, and anything you leave out is removed completely. The Starter's `clubedge.template.json` defines the modules, so a module a newer Starter adds gets its `--<module>` flag without a CLI change; `--help` lists the modules of the Starter this CLI release creates.

| Flag        | Options                                    | Default    |
| ----------- | ------------------------------------------ | ---------- |
| `--auth`    | `supabase`, `better-auth`, `firebase`, `appwrite`, `none` | `supabase` |
| `--storage` | `s3`, `supabase` (needs Supabase Auth), `none` | `s3`   |
| `--cache`   | `redis` (falls back to memory without `REDIS_URL`), `memory` | `redis` |
| `--email`   | `smtp` (any provider, or a local inbox), `resend`, `none` | `smtp` |
| `--payments` | `stripe` (needs an auth module), `none` | `none` |
| `--jobs` | `pg-boss`, `bullmq` (needs the `redis` cache), `inngest`, `none` | `none` |
| `--observability` | `otel` (OpenTelemetry, to any OTLP collector), `sentry`, `none` | `none` |
| `--deploy`  | `docker` (any container host), `fly`, `railway`, `render`, `vercel`, `netlify` | `docker` |
| `--infra`   | `docker` (Docker Compose), `supabase` (Supabase CLI), `local` (no Docker: PGlite and a local folder), `neon` (a free hosted Neon database), `none` | `docker` |

```sh
# Only the monorepo, UI, database, and tooling
pnpm dlx @clubedge/create-clubedge-app my-app --auth none --storage none --cache memory --email none

# A SaaS starting point: your own auth, payments, and background jobs, no Docker needed
pnpm dlx @clubedge/create-clubedge-app my-app --auth better-auth --payments stripe --jobs pg-boss --infra local
```

Interactive runs ask whether to customize these after the framework question.

## Options

```text
Usage:
  pnpm dlx @clubedge/create-clubedge-app [project-directory] [options]
  pnpm dlx @clubedge/create-clubedge-app add [module option]...  (inside a project)
  pnpm dlx @clubedge/create-clubedge-app remove [module]...      (inside a project)
  pnpm dlx @clubedge/create-clubedge-app upgrade [--ref <tag>]   (inside a project)

Options:
  --framework <id>        App framework, such as next or tanstack-start (or vite, a frontend)
  --api <id>              A separate API for a frontend, such as hono or fastapi
  --<module> <option>     A module option, such as --auth none; the Starter lists its modules
  --ref <ref>             Download this Starter tag, branch, or commit from GitHub instead
                          (upgrade: the Starter to upgrade to)
  --template-dir <path>   Scaffold from a local Starter checkout (for Starter development)
  --dry-run               Show what would be created or changed without writing anything
  --force                 add/remove: change a project with uncommitted changes or without Git
  -y, --yes               Accept defaults and never prompt (default directory: my-app)
  --no-install            Skip dependency installation
  --no-git                Skip Git repository initialization
  -h, --help              Show this help
  -v, --version           Show the CLI version
```

The target directory must be empty or not exist. The CLI never deletes or overwrites existing files, and if scaffolding fails it removes whatever it wrote, so a failed run leaves nothing behind.

```sh
# Preview the files and edits without writing anything
pnpm dlx @clubedge/create-clubedge-app my-app --dry-run

# Non-interactive, for scripts and CI
pnpm dlx @clubedge/create-clubedge-app my-app --yes --no-git --framework tanstack-start

# Try an unreleased Starter change
pnpm dlx @clubedge/create-clubedge-app my-app --ref main

# Reproduce a specific Starter release or commit
pnpm dlx @clubedge/create-clubedge-app my-app --ref v0.26.0
pnpm dlx @clubedge/create-clubedge-app my-app --ref <commit-sha>

# Test local Starter changes before releasing them
pnpm dlx @clubedge/create-clubedge-app my-app --template-dir ../clubedge-starter
```

## Change an existing project

Inside a project created by the CLI, `add` and `remove` change modules, and `upgrade` moves the project to a newer Starter release. Projects from Starter v0.8.0 on have a `clubedge` script, so `pnpm clubedge add cache redis` works too. Without a module or option, `add` and `remove` ask for them, with a list where you can pick several modules at once:

```sh
pnpm clubedge add                                            # choose a module and option from a list
pnpm dlx @clubedge/create-clubedge-app add cache redis      # or switch: add auth better-auth
pnpm dlx @clubedge/create-clubedge-app remove storage
pnpm clubedge add email resend payments stripe              # several modules as one change
pnpm clubedge remove storage payments
pnpm dlx @clubedge/create-clubedge-app add infra local --dry-run
pnpm dlx @clubedge/create-clubedge-app@latest upgrade        # to the newest CLI's Starter release
pnpm dlx @clubedge/create-clubedge-app upgrade --ref v0.26.0 # or a specific tag, branch, or commit
```

The CLI renders the project twice, from the Starter commit and modules recorded in your `package.json` and from the new state, and merges the difference into your project. The new state has other modules for `add` and `remove`, and the newer Starter with the same modules for `upgrade`. Modules a newer Starter introduces start as `none` where possible, so an upgrade never adds a service on its own.

- Files you never changed are updated, added, or deleted.
- Files you changed keep your edits. Where the module change touches the same lines, the file gets conflict markers (`<<<<<<< yours` ... `>>>>>>> clubedge`) for you to resolve. The Starter's whole new version of each such file is saved in `.clubedge/incoming/` to compare with yours (`git diff --no-index <file> .clubedge/incoming/<file>`); Git ignores that folder, so delete it when you are done.
- Your own files are never touched.
- Each app's local env file (`apps/web/.env.local`, and `apps/api/.env.local` with a separate API) keeps your values. Values still at their generated defaults follow the new selection, and new variables are added.
- `pnpm-lock.yaml` is replaced if you never changed your dependencies; otherwise `pnpm install` reconciles it.

Several modules in one command are applied as one change, and their requirements are checked together, so `add auth supabase storage supabase` works even though Supabase Storage needs Supabase Auth. When lines conflict, the CLI lists each file with its number of conflict blocks. Before an upgrade, it lists the Starter releases it crosses with the sections of their release notes, such as `v0.13.0  Observability, Tests, Also`.

The project must be a Git repository without uncommitted changes, so you can review the result with `git diff` and undo it. Pass `--force` to skip this check. Add `--no-install` to skip `pnpm install`. Afterward, run `pnpm db:migrate` and `pnpm check:services` if the change added tables or services.

pnpm cannot read a `package.json` with conflict markers, so a change that leaves conflicts in one skips `pnpm install` and says so: resolve them, then run `pnpm install`. Until then, `pnpm clubedge` does not start either, and the CLI's own commands (`pnpm dlx @clubedge/create-clubedge-app status`, for example) stop with a message that names the file and the command that compares it with the Starter's version in `.clubedge/incoming/`. When the install fails for another reason, the CLI still lists what is left to resolve, then exits with an error.

A change that leaves conflicts exits with 0, like a clean one. For scripts that need to tell them apart, add `--detailed-exit-code`: the CLI then exits with 2 when the change was written with conflicts to resolve, 0 when it was clean or there was nothing to change, and 1 when it failed.

## A hosted database with Neon

`--infra neon` gives the project a [Neon](https://neon.com) PostgreSQL database with nothing to install and no account:

```sh
pnpm dlx @clubedge/create-clubedge-app my-app --infra neon
cd my-app
pnpm db:migrate
pnpm dev
```

The CLI creates a free database through Neon's [claimable Postgres](https://neon.com/docs/reference/claimable-postgres) and writes two URLs into the env file of the app that owns the database, `apps/web/.env.local`, or `apps/api/.env.local` in a project with a separate API (a Vite frontend whose Better Auth server connects too gets the same `DATABASE_URL`): `DATABASE_URL`, the pooled connection the app uses, and `DATABASE_URL_DIRECT`, the direct one that migrations and the background jobs worker use, since a transaction pooler can break them. Neon keeps an unclaimed database for 72 hours, with up to 100 MB:

```sh
pnpm clubedge neon           # where it stands and how long it has left
pnpm clubedge neon claim     # opens Neon's page that moves it into your (free) Neon account
pnpm clubedge neon create    # a new database, for example after one expired
```

Claiming keeps the data but resets the password: copy the pooled and direct connection strings from the Neon console into the two variables afterward. To use a Neon project you already have, paste its URLs instead, or pass `--no-neon` to create nothing. `pnpm clubedge add infra neon` switches an existing project and creates a database when `DATABASE_URL` held the old infrastructure's example value. The CLI keeps what it needs to claim each database in `neon.json` in its config directory (`~/.config/clubedge`, or `%APPDATA%\clubedge` on Windows); treat it as a secret.

`doctor` checks the two URLs (pooled for the app, direct without `-pooler`, both from the same database) and warns when a free database has less than a day left. `deploy` sends `DATABASE_URL_DIRECT` with a `DATABASE_URL` from the env file, derives it from a pooled Neon URL when the file has none, and warns before deploying a database that is still unclaimed.

## Check a project

Two read-only commands help you keep a project healthy:

```sh
pnpm clubedge status    # Starter release, modules, Git state, and whether a newer Starter exists
pnpm clubedge doctor    # Node.js, pnpm, dependencies, lockfile, env file, and pnpm check:services
```

`status` ends with the command to run next, such as `pnpm clubedge upgrade` when a newer Starter release is available; it asks npm for the newest CLI and still works offline. `doctor` checks that Node.js and pnpm meet the project's versions, that dependencies are installed, that `pnpm-lock.yaml` matches every `package.json`, and that each app's local env file has every variable in its example (`apps/web/.env.local` and `.env.example`, and `apps/api/.env.local` and `apps/api/.env.example` with a separate API), then runs `pnpm check:services` (skip it with `--no-services`). It exits with an error when a check fails, so it also works in CI.

## Try it on a Railway VM (experimental)

No Node.js setup, database, or Docker to spare? `try` creates the project on a free, temporary Linux VM from [Railway](https://railway.com/free-vm) instead of your machine, and prints a preview URL:

```sh
pnpm dlx @clubedge/create-clubedge-app try
pnpm dlx @clubedge/create-clubedge-app try --framework tanstack-start --auth none
```

The VM needs no Railway account and lasts 60 minutes; to keep it, open the claim link the CLI prints within 24 hours after, which moves the VM, its files, and its URL into a Railway account. Keep that link private. Until the VM is claimed, the preview opens only from the IP address that created it (not from another device on mobile data, or through a VPN); claiming makes the URL shareable. Railway allows 3 free VMs per network per day.

The VM has no Docker, so the project uses `--infra local` (PGlite) and Better Auth unless you choose `--auth none`, with email off; other module flags apply as usual. With `--infra neon`, the CLI creates a free Neon database first, the VM migrates it, and `neon claim` (run outside a project) keeps it after the VM is gone.

Inside a project, `pnpm clubedge try` uploads that project instead, to share work in progress without deploying it. It sends what Git would commit (tracked files, plus untracked ones that are not ignored) and never `.env` files other than examples, `node_modules`, or build output; on the VM, the env file is made from `.env.example` as `create` does. The project must use `infra local`, `neon`, or `none`, and not Supabase Auth; with `neon`, the VM gets `DATABASE_URL` and `DATABASE_URL_DIRECT` from your env file; `pnpm clubedge add infra local` switches a Docker project. Add `--dry-run` to list the files without uploading anything.

When the app is ready, the CLI opens the preview in your browser (`--no-open` turns that off) and asks whether to share it: claiming the VM, a free Railway sign-up, is what makes the URL work for anyone. `--claim` opens the claim page without asking. `try --status` shows the last VM's preview, time left, and claim link; it connects only while the VM is running, so it never creates a new one. To open the app from another network yourself, forward it: `ssh -i <key> -N -L 3000:127.0.0.1:3000 railway.new`, then http://localhost:3000 (the CLI prints the exact command). The CLI asks before creating anything (`--yes` agrees), keeps its own SSH key in your config directory (`~/.config/clubedge`, or `%APPDATA%\clubedge` on Windows) apart from `~/.ssh`, and connects only to Railway's known host key. Railway's [terms](https://railway.com/legal/terms) apply, and Railway can change or pause its free VM.

## Deploy to Railway

In a project created with `--deploy railway` (or switched with `pnpm clubedge add deploy railway`), one command does the first deploy:

```sh
pnpm clubedge deploy                              # asks before creating anything; reads .env.production
pnpm clubedge deploy --env-file .env.staging      # with another file of production keys
pnpm clubedge deploy --dry-run                    # show the plan, create nothing
```

With [Railway's CLI](https://docs.railway.com/cli) (the installed `railway`, or `npx @railway/cli`) and your Railway login, it creates or reuses a project named after the package and the databases selected by the modules. Full-stack projects get one public app service. A Vite project gets two services: the frontend has the public `*.up.railway.app` domain, and the API stays private; the frontend's Node server (`node server.mjs`) forwards the API routes to it over Railway's private network. API variables, including `FRONTEND_URL`, go on the API service; `VITE_*` values go on the frontend service for its build. With Better Auth, the frontend's Node server runs auth: it gets the same `DATABASE_URL` as the API, a generated `BETTER_AUTH_SECRET`, the email settings, and `BETTER_AUTH_URL`, the public frontend URL both services use. Each service's unset variables are reported from its own env example. The API's migration command runs before the API release, and the frontend and API deployments are both awaited. Database variables are references to Railway's Postgres and Redis by default. Values from `.env.production` (or `--env-file`) take precedence; external database URLs stay external, and localhost URLs are ignored. `.railway/railway.ts` describes the selected service topology and health checks; `deploy` applies it and adds Railway's TypeScript SDK (`railway`) as a dev dependency. Commit the generated file and package changes. It needs Railway CLI 5.42.1 or newer. Running `deploy` again reuses the services, so it also adds variables and ships new releases. Railway bills usage on your plan.

### Deploy to Fly.io (experimental)

In a project with `--deploy fly`, `pnpm clubedge deploy` does the same with [Fly's CLI](https://fly.io/docs/flyctl/install/) (install it first; it is not on npm) and your Fly login: it creates the app (`fly launch`, which writes its name and region into `fly.toml`; commit it), an unmanaged Postgres app attached as `DATABASE_URL` (one `shared-cpu-1x` machine and a 1 GB volume) and Upstash Redis with `cache redis`, each unless the env file has its URL, and imports the secrets (the public URL `https://<app>.fly.dev`, a kept `BETTER_AUTH_SECRET`, and `--env-file` values). Then `fly deploy` builds the Dockerfile with `NEXT_PUBLIC_APP_URL` as a build argument, runs the migrations as the release command, and waits for the health checks. Fly bills these on your plan; for Fly's Managed Postgres, create and attach it yourself before deploying. Running it again reuses everything.

### Deploy to Vercel (experimental)

In a project with `--deploy vercel`, `pnpm clubedge deploy` uses [Vercel's CLI](https://vercel.com/docs/cli) (the installed `vercel`, else the latest through npx) and your Vercel login, running `vercel login` first when you are signed out. Vercel only runs the app, so the database and the other services come from the env file: `DATABASE_URL` (your provider's pooled URL, for example Neon's or Supabase's) is required. It creates or reuses a project named after the package, built from `apps/web` with the whole workspace uploaded, and writes a `.vercelignore` when the project has none, so `.env` files stay on your machine (commit it). It sets the production variables: the env file's values, the public URL, and a generated `BETTER_AUTH_SECRET` with Better Auth. `STORAGE_DIRECTORY` is left out, since Vercel keeps no disk. Then `vercel deploy --prod` builds the app, after `check:env` and the migrations. When Vercel names the app something other than `https://<project>.vercel.app`, `deploy` sets that URL and deploys again, since the build compiles it in. Running it again reuses the project. Vercel bills usage on your plan.

### Deploy to Netlify (experimental)

In a project with `--deploy netlify`, `pnpm clubedge deploy` uses [Netlify's CLI](https://docs.netlify.com/cli/get-started/) (the installed `netlify`, else the latest through npx) and your Netlify login: `netlify login` opens the browser when you are signed out, and returns at once when you are signed in. As on Vercel, the services come from the env file, and `DATABASE_URL` (your provider's pooled URL) is required. It creates or reuses a site named after the package (with a short suffix when the name is taken, since Netlify's names are global), with `apps/web` as its base directory, and links the project to it in `.netlify/state.json`. It imports the production variables from a temporary file, so no value appears on a command line: the env file's values, the site's `https://<site>.netlify.app` URL, and a generated `BETTER_AUTH_SECRET` with Better Auth. Then `netlify deploy --build --prod` builds on your machine with the site's variables (`check:env`, the migrations, then the build) and uploads the result. Running it again reuses the site. Netlify bills usage on your plan.

### Deploy to Render (experimental)

In a project with `--deploy render`, `pnpm clubedge deploy` uses Render's API. Render builds the Dockerfile from your Git repository, so push the project to GitHub, GitLab, or Bitbucket first, with Render's access to it granted in the dashboard; `deploy` warns about commits that aren't pushed. It signs in with an API key: `RENDER_API_KEY`, or else it opens the dashboard's API keys page and asks you to paste one. It creates or reuses a web service named after the package, on the Docker runtime and a starter instance (pre-deploy commands need a paid type), which runs `node /app/migrate.mjs` before each release, checks `/api/health`, and deploys again on each push, as `render.yaml` describes. `DATABASE_URL` comes from the env file (Render Postgres, Neon, Supabase, ...). It sets the production variables: the env file's values, the service's `*.onrender.com` URL, and a generated `BETTER_AUTH_SECRET` that later runs keep. Then it starts a deploy and waits until it is live. When Render names the app something other than `https://<service>.onrender.com`, `deploy` sets that URL and deploys again, since the build compiles it in. Running it again reuses the service. Render bills the instance on your plan.

### Preview deployments

In a project that deploys to Vercel or Railway, `pnpm clubedge deploy --preview` deploys the current Git branch next to production, after a first `deploy`:

```sh
NEON_API_KEY=... NEON_PROJECT_ID=... pnpm clubedge deploy --preview
```

With `NEON_API_KEY` and `NEON_PROJECT_ID` (in the shell, or in the env file), the preview gets its own [Neon branch](https://neon.com/docs/introduction/branching), `preview/<git branch>`: a copy of the production database made in seconds that shares its storage until it changes. `deploy` creates it, or reuses it on later runs, applies this branch's migrations to it, and points the preview's `DATABASE_URL` and `DATABASE_URL_DIRECT` at it. On Vercel, the preview is a preview deployment with the project's Preview variables, and the branch's URLs are set as Preview variables of your Git branch, which needs the Vercel project connected to its Git repository; without the Neon settings, it uses the Preview `DATABASE_URL`. On Railway, it is an environment named `preview-<git branch>`, copied from production with its own domain; without the Neon settings, it gets its own empty copy of Railway's Postgres, and when production's database comes from elsewhere, `deploy --preview` refuses, since the copy would use production's data. Production is not changed. It deploys a single app for now: a Vite frontend and its API are two services, so `deploy --preview` refuses them and explains how to copy production's Railway environment yourself.

Projects created with `--infra neon` also have `.github/workflows/preview.yml`, which does this for every pull request in CI: a Neon branch per pull request with its migrations, the schema diff as a comment, a Vercel or Railway preview, and cleanup when the pull request closes. The Starter's SETUP.md lists the secrets it needs.

## Version relationship

Each CLI release is tested against one specific Starter release:

```text
create-clubedge-app v0.41.0
        |
        v
Clubedge Starter v0.26.0
commit 7c01a0295bea53adc72bda5b843a478ddd04f892
```

The current relationship is:

| CLI release | Default Starter release | Meaning |
| --- | --- | --- |
| `create-clubedge-app@0.41.0` | `clubedge-starter@v0.26.0` | The CLI's required, tested default |

This means the same CLI version always scaffolds the same Starter revision by default. The CLI does not silently follow Starter `main`.

The `v0.26.0` tag is expected to resolve to commit
`7c01a0295bea53adc72bda5b843a478ddd04f892`. The CLI verifies this before
scaffolding with the default reference and fails rather than silently using a
moved tag.

When the Starter changes, its maintainers first publish a new versioned release, such as `v0.26.0`. The CLI is then updated to use that release, all generated-project checks must pass, and a new CLI version is published. This keeps Starter and CLI releases independently versioned while preserving a tested compatibility relationship.

Every generated project records its CLI version, Starter repository, Starter ref, Starter commit, framework, and modules in `package.json` and `README.md`.

## How it works

Each CLI release bundles one Starter release. When the release is built, `scripts/bundle-template.mjs` clones the pinned Starter tag, verifies that it resolves to the pinned commit, and copies its tracked files into the package (`template/` and `template.lock.json`). Running the CLI then needs no GitHub access for the default Starter.

The Starter describes itself in `clubedge.template.json`: its app directory, site config, environment files, Docker image name, and files that stay out of generated projects. Schema 2 manifests also list each framework's app directory, environment example, and Dockerfile. The CLI moves the selected framework's app to `apps/web` (renaming its package to `@clubedge/web`), moves its environment example and Dockerfile to the project root, leaves the other frameworks out, and removes their entries from `pnpm-lock.yaml` so `pnpm install --frozen-lockfile` keeps working. Schema 3 adds `modules`: for each option, the workspace packages it uses, the files it owns, the variant files that replace defaults, the root `package.json` scripts it sets, and the options it requires. Files listed under `conditional` contain `clubedge:if <condition>` / `clubedge:end` blocks (in `#`, `//`, `<!-- -->`, or JSX comments) that the CLI keeps or drops for the selection, always removing the markers; `clubedge:if starter-repository` marks sections for Starter maintainers only. The CLI refuses a Starter whose manifest schema is newer than it understands and asks you to update. Starters before v0.3.0 have no manifest and use the previous layout.

The CLI first builds a plan (the files to copy and the edits to make), which `--dry-run` prints, and then applies it. The source is organized the same way:

```text
src/
  cli/      argument parsing and terminal output
  core/     manifest, template sources, customizations, planning, merging, and execution
  steps/    Git initialization and dependency installation
  utils/    file listing and copying, processes, and naming
```

## Documentation

| I want to | Read |
| --- | --- |
| Configure a generated project | Its `SETUP.md`, also in the [Starter repository](https://github.com/Clubedge/clubedge-starter/blob/main/SETUP.md) |
| Change modules or upgrade a project | [Change an existing project](#change-an-existing-project) |
| See where a project stands, or why it does not run | [Check a project](#check-a-project) |
| Reproduce an exact Starter version | [Version relationship](#version-relationship) |
| See what changed in each release | [CHANGELOG.md](CHANGELOG.md) |
| See what is planned next | [ROADMAP.md](ROADMAP.md) |
| Contribute code | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Report a security problem | [SECURITY.md](SECURITY.md) |

## Development

```sh
corepack enable
pnpm install
pnpm check            # type-check sources and tests
pnpm test             # unit and scaffolding tests
pnpm build            # compile src/ to dist/
node ./bin/create.mjs my-app --template-dir ../clubedge-starter --dry-run
```

Without a bundled template, a local build downloads the pinned Starter release from GitHub and verifies its commit. Run `pnpm bundle-template` to bundle it, or `pnpm bundle-template --from ../clubedge-starter` to bundle a local checkout.

CI packs the CLI with `npm pack`, scaffolds clean projects from the packed tarball, installs their dependencies, runs linting, typechecking, unit tests, browser checks, and a production build, then starts each generated app and checks the landing page, sign-up page, dashboard, health endpoint, logo, and favicon. It also adds and removes modules in an existing project and upgrades a project from an older Starter. A scheduled, non-blocking compatibility job checks Starter `main`.

## Release workflow

### Starter maintainers

1. Make and validate changes in `clubedge-starter`.
2. Run lint, typecheck, unit tests, browser tests, and production build.
3. Update the Starter package versions.
4. Commit `main`, create a release tag such as `v0.26.0`, and publish the Starter release.

### CLI maintainers

1. When the Starter publishes a release, the [Starter pin](.github/workflows/starter-pin.yml) workflow opens a pull request that moves `clubedge.starterRef` and `clubedge.starterCommit` in [`package.json`](package.json), and the docs that name them, to the new tag (daily, or run it by hand; locally: `pnpm release pin vX.Y.Z`). Its CI generates clean projects from that exact tag and runs install, lint, typecheck, unit tests, browser tests, production build, and runtime smoke checks. Merge it once they pass.
2. `pnpm release patch|minor|major` (from an up-to-date `main`; add `--dry-run` to preview) opens the release pull request: it bumps `version`, updates the version relationship here and in CONTRIBUTING, adds the release table rows for a minor or major release, and drafts the changelog entry from the pull requests merged since the last tag. Edit the draft in that pull request: it becomes the GitHub Release page.
3. After it is merged, `pnpm release tag` tags `main`. The Release workflow checks and publishes it to npm, creates the GitHub Release page from the changelog entry, and smoke-tests the published package.

The pin workflow needs **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**, or a `STARTER_PIN_TOKEN` secret (a fine-grained token with contents and pull requests write), which also lets its pull request start CI by itself.

The required CI job always tests the pinned default. The scheduled compatibility job tests Starter `main` early, but unreleased Starter changes must not change the stable CLI default.

## Roadmap

Each phase ends with a Starter release and a CLI release pinned to it. The full plan is in [ROADMAP.md](ROADMAP.md).

| CLI release | Starter release | Theme |
| --- | --- | --- |
| 0.5.0 to 0.9.0 | v0.5.0 to v0.8.0 | Optional modules, local services, `add`, `remove`, and `upgrade` |
| 0.10.0 | v0.9.0 | Module flags from the Starter's manifest, and email |
| 0.11.0 | v0.10.0 | Deployment |
| 0.12.0 | v0.11.0 | Payments |
| 0.13.0 | v0.12.0 | Background jobs |
| 0.14.0 | v0.13.0 | Observability |
| 0.15.0 | v0.13.1 | `status` and `doctor`, several modules in one change, conflict and upgrade summaries, macOS CI |
| 0.16.0 | v0.14.0 | Account settings page, browser error reporting and Sentry source maps, auth emails through the jobs queue |
| 0.17.0 | v0.15.0 | Docs-style dashboard: sidebar with a section switcher and account card, page in a scrolling card, phone drawer |
| 0.18.0 | v0.15.0 | `try`: a new project on a free, temporary Railway VM, with a preview URL and a claim link (experimental) |
| 0.19.0 | v0.15.0 | `pnpm clubedge try` uploads an existing project to the VM; the preview opens in the browser |
| 0.20.0 | v0.15.0 | The Starter's version of each conflicted file in `.clubedge/incoming/`, several modules at once, sharing a `try` preview by claiming the VM, `try --status` |
| 0.21.0 | v0.16.0 | Starter v0.16.0: upgrades delivered as pull requests, Node 24 actions; release tooling for maintainers |
| 0.22.0 | v0.16.1 | `pnpm clubedge deploy`: a guided first deploy to Railway; faster Docker builds |
| 0.23.0 | v0.16.1 | `deploy` moves Railway projects to `.railway/railway.ts` before Railway stops reading `railway.json` |
| 0.24.0 | v0.17.0 | Starter v0.17.0: Railway configuration as code (`.railway/railway.ts`) instead of `railway.json` |
| 0.25.0 | v0.17.1 | `deploy` to Fly.io (experimental); weekly Dependabot updates |
| 0.26.0 | v0.17.1 | `deploy` uses your own databases (Supabase, Neon, Upstash) when the env file has their URLs, and reads `.env.production` |
| 0.27.0 | v0.18.0 | Starter v0.18.0: Vercel and Netlify builds stop when a production variable is missing (`pnpm check:env`) |
| 0.28.0 | v0.18.0 | `deploy` to Vercel (experimental) |
| 0.29.0 | v0.18.0 | `deploy` to Netlify and Render (experimental) |
| 0.30.0 | v0.19.0 | `--infra neon` with a free Neon database, the `neon` command, `deploy --preview` with a Neon branch per preview |
| 0.30.1 | v0.19.1 | Railway previews work with a workspace token and answer on the port their domain targets |
| 0.31.0 | v0.20.0 | Pluggable background jobs: `--jobs bullmq` and `--jobs inngest` next to pg-boss, and a conformance suite every provider passes |
| 0.32.0 | v0.21.0 | Pluggable authentication: `--auth firebase` and `--auth appwrite` next to Supabase and Better Auth, and a conformance suite every provider passes |
| 0.33.0 | v0.22.0 | Starter v0.22.0: stack packs (template schema 4), and a React + Vite frontend with a separate Hono API (`--framework vite --api hono`) |
| 0.34.0 | v0.23.0 | Starter v0.23.0: a FastAPI API in Python (`--framework vite --api fastapi`), generated with no CLI change |
| 0.35.0 | v0.24.0 | `deploy` for a frontend and its API (Docker Compose, Railway); Starter v0.24.0: all four auth providers on React + Vite with Hono or FastAPI |
| 0.36.0 | v0.24.1 | Starter v0.24.1: security update of FastAPI's `certifi`; dependency updates |
| 0.37.0 | v0.24.1 | An MCP server (capabilities, validate, plan, create) and an agent skill for coding agents |
| 0.38.0 | v0.24.2 | Starter v0.24.2: Next.js security update (critical RCE advisories); database URLs, Neon, and deploy variables for a frontend and its API |
| 0.39.0 | v0.25.0 | Starter v0.25.0: every module on React + Vite with Hono, and account settings on React + Vite |
| 0.40.0 | v0.26.0 | Starter v0.26.0: every module on React + Vite with FastAPI (pg-boss excepted) |
| 0.41.0 | v0.26.0 | Skip pnpm install and explain a package.json with conflict markers; Detect unresolved conflict markers in doctor; Preserve project version and custom README across upgrades (Phase 2); Conflict on a pnpm override now that projects own their version |

## Community

- **[Issues](https://github.com/Clubedge/create-clubedge-app/issues)** for problems creating, changing, or upgrading a project.
- **[Clubedge Starter issues](https://github.com/Clubedge/clubedge-starter/issues)** for problems in the generated application itself.
- **[Pull requests](https://github.com/Clubedge/create-clubedge-app/pulls)** are welcome; start with [CONTRIBUTING.md](CONTRIBUTING.md).
- **Security problems** go through the private process in [SECURITY.md](SECURITY.md), not public issues.

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).

## License

Copyright 2026 Clubedge Digital Systems. Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
