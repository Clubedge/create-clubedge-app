# create-clubedge-app

[![CI](https://github.com/Clubedge/create-clubedge-app/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Clubedge/create-clubedge-app/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Create a Next.js application from the [Clubedge Starter](https://github.com/Clubedge/clubedge-starter) reference implementation.

The CLI downloads a tested Starter release, names the generated project, creates `apps/web/.env.local` from the example, initializes Git, and installs dependencies. The Starter remains the source of truth for the generated architecture.

## Version relationship

Each CLI release is tested against one specific Starter release:

```text
create-clubedge-app v0.3.0
        |
        v
Clubedge Starter v0.3.0
commit 60f1691920c91a5cf83e480a3ce98c3ddefdef55
```

The current relationship is:

| CLI release | Default Starter release | Meaning |
| --- | --- | --- |
| `create-clubedge-app@0.3.0` | `clubedge-starter@v0.3.0` | The CLI's required, tested default |

This means the same CLI version always scaffolds the same Starter revision by default. The CLI does not silently follow Starter `main`.

The `v0.3.0` tag is expected to resolve to commit
`60f1691920c91a5cf83e480a3ce98c3ddefdef55`. The CLI verifies this before
scaffolding with the default reference and fails rather than silently using a
moved tag.

When the Starter changes, its maintainers first publish a new versioned release, such as `v0.3.0`. The CLI is then updated to use that release, all generated-project checks must pass, and a new CLI version is published. This keeps Starter and CLI releases independently versioned while preserving a tested compatibility relationship.

## Requirements

- Node.js 22.12 or newer.
- pnpm 10.9.0 or newer. The generated project is a pnpm workspace, so dependencies are installed with pnpm even when you start the CLI with `npx`; the CLI falls back to `corepack pnpm` when `pnpm` is not on your path.
- Git, when using the default Git initialization.
- Internet access to install dependencies. The default Starter release ships inside the CLI package, so GitHub is only contacted for `--ref`.

## Usage

```sh
pnpm dlx @clubedge/create-clubedge-app my-app
```

Or run it with npm:

```sh
npx @clubedge/create-clubedge-app my-app
```

After scaffolding:

```sh
cd my-app
pnpm dev
```

The generated project includes `.env.local`; fill in `DATABASE_URL` to start the app and configure Supabase Auth or other providers as needed. The root route is a project-named landing page, and the reference dashboard is available at `/dashboard`. See its `SETUP.md` for database, Redis, storage, and Docker setup.

When no destination is provided, the CLI asks where to create the project:

```sh
pnpm dlx @clubedge/create-clubedge-app
```

## Options

```text
Usage: pnpm dlx @clubedge/create-clubedge-app [project-directory] [options]

--ref <ref>             Download this Starter tag, branch, or commit from GitHub instead
--template-dir <path>   Scaffold from a local Starter checkout (for Starter development)
--dry-run               Show what would be created without writing anything
-y, --yes               Accept defaults and never prompt (default directory: my-app)
--no-install            Skip dependency installation
--no-git                Skip Git initialization
-h, --help              Show help
-v, --version           Show the CLI version
```

The target directory must be empty or not exist. The CLI never deletes or overwrites existing files, and if scaffolding fails it removes whatever it wrote, so a failed run leaves nothing behind.

Every generated project records its CLI version, Starter repository, Starter ref, and Starter commit in `package.json` and `README.md`.

```sh
# Preview the files and edits without writing anything
pnpm dlx @clubedge/create-clubedge-app my-app --dry-run

# Non-interactive, for scripts and CI
pnpm dlx @clubedge/create-clubedge-app my-app --yes --no-git

# Try an unreleased Starter change
pnpm dlx @clubedge/create-clubedge-app my-app --ref main

# Reproduce a specific Starter release or commit
pnpm dlx @clubedge/create-clubedge-app my-app --ref v0.3.0
pnpm dlx @clubedge/create-clubedge-app my-app --ref <commit-sha>

# Test local Starter changes before releasing them
pnpm dlx @clubedge/create-clubedge-app my-app --template-dir ../clubedge-starter
```

## How it works

Each CLI release bundles one Starter release. When the release is built, `scripts/bundle-template.mjs` clones the pinned Starter tag, verifies that it resolves to the pinned commit, and copies its tracked files into the package (`template/` and `template.lock.json`). Running the CLI then needs no GitHub access for the default Starter.

The Starter describes itself in `clubedge.template.json`: its app directory, site config, environment files, Docker image name, and files that stay out of generated projects. The CLI refuses a Starter whose manifest schema is newer than it understands and asks you to update. Starters before v0.3.0 have no manifest and use the previous layout.

The CLI first builds a plan (the files to copy and the edits to make), which `--dry-run` prints, and then applies it. The source is organized the same way:

```text
src/
  cli/      argument parsing and terminal output
  core/     manifest, template sources, customizations, planning, and execution
  steps/    Git initialization and dependency installation
  utils/    file listing and copying, processes, and naming
```

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

CI packs the CLI with `npm pack`, scaffolds a clean project from the packed tarball, installs its dependencies, runs linting, typechecking, unit tests, browser checks, and a production build, then starts the generated app and checks the landing page, sign-up page, dashboard, health endpoint, logo, and favicon. A scheduled, non-blocking compatibility job also checks Starter `main`.

## Release workflow

### Starter maintainers

1. Make and validate changes in `clubedge-starter`.
2. Run lint, typecheck, unit tests, browser tests, and production build.
3. Update the Starter package versions.
4. Commit `main`, create a release tag such as `v0.3.0`, and publish the Starter release.

### CLI maintainers

1. Set `clubedge.starterRef` and `clubedge.starterCommit` in [`package.json`](package.json) to the new tested Starter tag, and bump `version`.
2. Update the version relationship table and changelog.
3. Generate a clean project from that exact tag.
4. Run install, lint, typecheck, unit tests, browser tests, production build, and runtime smoke checks.
5. Publish a new CLI version only after the generated-project verification passes.

The required CI job always tests the pinned default. The scheduled compatibility job tests Starter `main` early, but unreleased Starter changes must not change the stable CLI default.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull request guidance. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Copyright 2026 Clubedge Digital Systems. Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
