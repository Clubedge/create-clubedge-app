# create-clubedge-app

[![CI](https://github.com/Clubedge/create-clubedge-app/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Clubedge/create-clubedge-app/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Create a Next.js application from the [Clubedge Starter](https://github.com/Clubedge/clubedge-starter) reference implementation.

The CLI downloads a tested Starter release, names the generated project, creates `apps/web/.env.local` from the example, initializes Git, and installs dependencies. The Starter remains the source of truth for the generated architecture.

## Version relationship

Each CLI release is tested against one specific Starter release:

```text
create-clubedge-app v0.1.9
        |
        v
Clubedge Starter v0.1.1
commit 0be0c18d41f01cd011c576fb65c25711081b8ad4
```

The current relationship is:

| CLI release | Default Starter release | Meaning |
| --- | --- | --- |
| `create-clubedge-app@0.1.9` | `clubedge-starter@v0.1.1` | The CLI's required, tested default |

This means the same CLI version always scaffolds the same Starter revision by default. The CLI does not silently follow Starter `main`.

The `v0.1.1` tag is expected to resolve to commit
`0be0c18d41f01cd011c576fb65c25711081b8ad4`. The CLI verifies this before
scaffolding with the default reference and fails rather than silently using a
moved tag.

When the Starter changes, its maintainers first publish a new versioned release, such as `v0.2.0`. The CLI is then updated to use that release, all generated-project checks must pass, and a new CLI version is published. This keeps Starter and CLI releases independently versioned while preserving a tested compatibility relationship.

## Requirements

- Node.js 22.12 or newer.
- pnpm 10.9.0 or newer (the generated starter uses Corepack and pnpm).
- Git, when using the default Git initialization.
- Internet access to download the starter from GitHub and install dependencies.

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

--ref <ref>            Select a starter tag, branch, or commit (default: v0.1.1)
--no-install           Skip pnpm install
--no-git               Skip Git initialization
-h, --help             Show help
-v, --version          Show the CLI version
```

Examples:

```sh
pnpm dlx @clubedge/create-clubedge-app my-app --ref <starter-tag-or-commit>
pnpm dlx @clubedge/create-clubedge-app my-app --no-install
```

The target directory must be empty or not exist. The CLI will not delete or overwrite files in a non-empty target directory. The default is the tested `v0.1.1` Starter release, so the same CLI version produces the same Starter revision. Use `--ref` to explicitly select a tag, branch, or commit.

The default is the tested Starter release tag `v0.1.1`. Every generated project records its CLI version, Starter repository, exact Starter ref, and resolved Starter commit in `package.json` and `README.md`.

Use `--ref` only when you intentionally want a different Starter revision:

```sh
# Reproduce the supported default
pnpm dlx @clubedge/create-clubedge-app my-app

# Try an unreleased Starter change
pnpm dlx @clubedge/create-clubedge-app my-app --ref main

# Reproduce a specific Starter release or commit
pnpm dlx @clubedge/create-clubedge-app my-app --ref v0.1.1
pnpm dlx @clubedge/create-clubedge-app my-app --ref <commit-sha>
```

## How it works

This CLI scaffolds the complete reference Starter. It does not yet offer selectable SaaS, dashboard, or minimal feature presets; those should be added once each preset has a distinct, maintained template. This keeps CLI output aligned with the Starter repository instead of creating a second, drifting copy of its source.

## Development

```sh
corepack enable
pnpm install
node ./bin/create.mjs --help
pnpm check
pnpm test
```

CI scaffolds a clean project from the pinned Starter release, installs its dependencies, runs linting, typechecking, unit tests, browser checks, and a production build, then starts the generated app and checks the landing page, sign-up page, dashboard, health endpoint, logo, and favicon. A scheduled, non-blocking compatibility job also checks Starter `main`.

## Release workflow

### Starter maintainers

1. Make and validate changes in `clubedge-starter`.
2. Run lint, typecheck, unit tests, browser tests, and production build.
3. Update the Starter package versions.
4. Commit `main`, create a release tag such as `v0.2.0`, and publish the Starter release.

### CLI maintainers

1. Change `defaultStarterRef` in [`bin/create.mjs`](bin/create.mjs) to the new tested Starter tag.
2. Update the version relationship table and changelog.
3. Generate a clean project from that exact tag.
4. Run install, lint, typecheck, unit tests, browser tests, production build, and runtime smoke checks.
5. Publish a new CLI version only after the generated-project verification passes.

The required CI job always tests the pinned default. The scheduled compatibility job tests Starter `main` early, but unreleased Starter changes must not change the stable CLI default.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull request guidance. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Copyright 2026 Clubedge Digital Systems. Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
