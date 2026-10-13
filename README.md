<div align="center">

# create-clubedge-app

**Create a production-ready Next.js or TanStack Start app with one command, and keep it up to date.**

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

The generated project includes `apps/web/.env.local`, created from the example and pointing at the local services you chose. Its `SETUP.md` describes every variable and provider. The root route is a landing page named after your project, and the dashboard is at `/dashboard`.

The default Starter release ships inside the CLI package, so GitHub is only contacted when you pass `--ref`. Internet access is needed to install dependencies.

## Choosing a framework

The Starter ships the same application for two React frameworks. Next.js is the default; pick TanStack Start with `--framework`, or choose interactively:

```sh
pnpm dlx @clubedge/create-clubedge-app my-app --framework tanstack-start
```

| `--framework`    | App                         | Production output             |
| ---------------- | --------------------------- | ----------------------------- |
| `next`           | Next.js App Router          | Next.js standalone build      |
| `tanstack-start` | TanStack Start with Vite    | Nitro `.output` server bundle |

Either way, the app lives in `apps/web` and uses the same shared packages, so the project layout, root scripts, and Docker commands are identical.

## Choosing modules

Authentication, file storage, caching, email, payments, background jobs, observability, local infrastructure, and deployment are modules. Each has a default, and anything you leave out is removed completely. The Starter's `clubedge.template.json` defines the modules, so a module a newer Starter adds gets its `--<module>` flag without a CLI change; `--help` lists the modules of the Starter this CLI release creates.

| Flag        | Options                                    | Default    |
| ----------- | ------------------------------------------ | ---------- |
| `--auth`    | `supabase`, `better-auth`, `none`          | `supabase` |
| `--storage` | `s3`, `supabase` (needs Supabase Auth), `none` | `s3`   |
| `--cache`   | `redis` (falls back to memory without `REDIS_URL`), `memory` | `redis` |
| `--email`   | `smtp` (any provider, or a local inbox), `resend`, `none` | `smtp` |
| `--payments` | `stripe`, `none` (needs an auth module) | `none` |
| `--jobs` | `pg-boss`, `none` | `none` |
| `--observability` | `otel` (OpenTelemetry, to any OTLP collector), `sentry`, `none` | `none` |
| `--deploy`  | `docker` (any container host), `fly`, `railway`, `render`, `vercel`, `netlify` | `docker` |
| `--infra`   | `docker` (Docker Compose), `supabase` (Supabase CLI), `local` (no Docker: PGlite and a local folder), `none` | `docker` |

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
  --framework <id>        App framework, such as next or tanstack-start
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
pnpm dlx @clubedge/create-clubedge-app my-app --ref v0.16.1
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
pnpm dlx @clubedge/create-clubedge-app upgrade --ref v0.16.1 # or a specific tag, branch, or commit
```

The CLI renders the project twice, from the Starter commit and modules recorded in your `package.json` and from the new state, and merges the difference into your project. The new state has other modules for `add` and `remove`, and the newer Starter with the same modules for `upgrade`. Modules a newer Starter introduces start as `none` where possible, so an upgrade never adds a service on its own.

- Files you never changed are updated, added, or deleted.
- Files you changed keep your edits. Where the module change touches the same lines, the file gets conflict markers (`<<<<<<< yours` ... `>>>>>>> clubedge`) for you to resolve. The Starter's whole new version of each such file is saved in `.clubedge/incoming/` to compare with yours (`git diff --no-index <file> .clubedge/incoming/<file>`); Git ignores that folder, so delete it when you are done.
- Your own files are never touched.
- `apps/web/.env.local` keeps your values. Values still at their generated defaults follow the new selection, and new variables are added.
- `pnpm-lock.yaml` is replaced if you never changed your dependencies; otherwise `pnpm install` reconciles it.

Several modules in one command are applied as one change, and their requirements are checked together, so `add auth supabase storage supabase` works even though Supabase Storage needs Supabase Auth. When lines conflict, the CLI lists each file with its number of conflict blocks. Before an upgrade, it lists the Starter releases it crosses with the sections of their release notes, such as `v0.13.0  Observability, Tests, Also`.

The project must be a Git repository without uncommitted changes, so you can review the result with `git diff` and undo it. Pass `--force` to skip this check. Add `--no-install` to skip `pnpm install`. Afterward, run `pnpm db:migrate` and `pnpm check:services` if the change added tables or services.

## Check a project

Two read-only commands help you keep a project healthy:

```sh
pnpm clubedge status    # Starter release, modules, Git state, and whether a newer Starter exists
pnpm clubedge doctor    # Node.js, pnpm, dependencies, lockfile, env file, and pnpm check:services
```

`status` ends with the command to run next, such as `pnpm clubedge upgrade` when a newer Starter release is available; it asks npm for the newest CLI and still works offline. `doctor` checks that Node.js and pnpm meet the project's versions, that dependencies are installed, that `pnpm-lock.yaml` matches every `package.json`, and that `apps/web/.env.local` has every variable in `.env.example`, then runs `pnpm check:services` (skip it with `--no-services`). It exits with an error when a check fails, so it also works in CI.

## Try it on a Railway VM (experimental)

No Node.js setup, database, or Docker to spare? `try` creates the project on a free, temporary Linux VM from [Railway](https://railway.com/free-vm) instead of your machine, and prints a preview URL:

```sh
pnpm dlx @clubedge/create-clubedge-app try
pnpm dlx @clubedge/create-clubedge-app try --framework tanstack-start --auth none
```

The VM needs no Railway account and lasts 60 minutes; to keep it, open the claim link the CLI prints within 24 hours after, which moves the VM, its files, and its URL into a Railway account. Keep that link private. Until the VM is claimed, the preview opens only from the IP address that created it (not from another device on mobile data, or through a VPN); claiming makes the URL shareable. Railway allows 3 free VMs per network per day.

The VM has no Docker, so the project uses `--infra local` (PGlite) and Better Auth unless you choose `--auth none`, with email off; other module flags apply as usual.

Inside a project, `pnpm clubedge try` uploads that project instead, to share work in progress without deploying it. It sends what Git would commit (tracked files, plus untracked ones that are not ignored) and never `.env` files other than examples, `node_modules`, or build output; on the VM, the env file is made from `.env.example` as `create` does. The project must use `infra local` or `none`, and not Supabase Auth; `pnpm clubedge add infra local` switches a Docker project. Add `--dry-run` to list the files without uploading anything.

When the app is ready, the CLI opens the preview in your browser (`--no-open` turns that off) and asks whether to share it: claiming the VM, a free Railway sign-up, is what makes the URL work for anyone. `--claim` opens the claim page without asking. `try --status` shows the last VM's preview, time left, and claim link; it connects only while the VM is running, so it never creates a new one. To open the app from another network yourself, forward it: `ssh -i <key> -N -L 3000:127.0.0.1:3000 railway.new`, then http://localhost:3000 (the CLI prints the exact command). The CLI asks before creating anything (`--yes` agrees), keeps its own SSH key in your config directory (`~/.config/clubedge`, or `%APPDATA%\clubedge` on Windows) apart from `~/.ssh`, and connects only to Railway's known host key. Railway's [terms](https://railway.com/legal/terms) apply, and Railway can change or pause its free VM.

## Deploy to Railway

In a project created with `--deploy railway` (or switched with `pnpm clubedge add deploy railway`), one command does the first deploy:

```sh
pnpm clubedge deploy                              # asks before creating anything
pnpm clubedge deploy --env-file .env.production   # with your production provider keys
pnpm clubedge deploy --dry-run                    # show the plan, create nothing
```

With [Railway's CLI](https://docs.railway.com/cli) (the installed `railway`, or `npx @railway/cli`) and your Railway login, it creates or reuses a project named after the package, Postgres (and Redis with `cache redis`), the app's service, and a `*.up.railway.app` domain. It sets the variables it can: `DATABASE_URL` and `REDIS_URL` as references to those databases, `APP_URL` and `NEXT_PUBLIC_APP_URL`, `PORT`, and a generated `BETTER_AUTH_SECRET` that later runs keep. Values from `--env-file` come on top; the variables `.env.example` lists that nothing sets are reported, for the modules that need them (storage, email, payments). Then `railway up` builds the Dockerfile, Railway runs the migrations before the release and checks `/api/health`, and the URL is printed. Running `deploy` again reuses everything, so it also adds variables and ships a new release. Railway bills usage on your plan.

## Version relationship

Each CLI release is tested against one specific Starter release:

```text
create-clubedge-app v0.22.0
        |
        v
Clubedge Starter v0.16.1
commit 72ff89e53a55a4e4a6262b364ce73be3b1c7a6b9
```

The current relationship is:

| CLI release | Default Starter release | Meaning |
| --- | --- | --- |
| `create-clubedge-app@0.22.0` | `clubedge-starter@v0.16.1` | The CLI's required, tested default |

This means the same CLI version always scaffolds the same Starter revision by default. The CLI does not silently follow Starter `main`.

The `v0.16.1` tag is expected to resolve to commit
`72ff89e53a55a4e4a6262b364ce73be3b1c7a6b9`. The CLI verifies this before
scaffolding with the default reference and fails rather than silently using a
moved tag.

When the Starter changes, its maintainers first publish a new versioned release, such as `v0.16.1`. The CLI is then updated to use that release, all generated-project checks must pass, and a new CLI version is published. This keeps Starter and CLI releases independently versioned while preserving a tested compatibility relationship.

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
4. Commit `main`, create a release tag such as `v0.16.1`, and publish the Starter release.

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
| next | | Show the Starter's version of a conflicted file next to yours |

## Community

- **[Issues](https://github.com/Clubedge/create-clubedge-app/issues)** for problems creating, changing, or upgrading a project.
- **[Clubedge Starter issues](https://github.com/Clubedge/clubedge-starter/issues)** for problems in the generated application itself.
- **[Pull requests](https://github.com/Clubedge/create-clubedge-app/pulls)** are welcome; start with [CONTRIBUTING.md](CONTRIBUTING.md).
- **Security problems** go through the private process in [SECURITY.md](SECURITY.md), not public issues.

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).

## License

Copyright 2026 Clubedge Digital Systems. Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
