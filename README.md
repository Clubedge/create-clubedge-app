# create-clubedge-app

[![CI](https://github.com/yassine-ahmed/create-clubedge-app/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/yassine-ahmed/create-clubedge-app/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Create a Next.js application from the [Clubedge Starter](https://github.com/yassine-ahmed/clubedge-starter) reference implementation.

The CLI downloads the starter repository, names the generated project, creates `apps/web/.env.local` from the example, initializes Git, and installs dependencies. The starter remains the source of truth for the generated architecture.

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

--ref <ref>            Select a starter tag, branch, or commit (default: v0.1.0)
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

The target directory must be empty or not exist. The CLI will not delete or overwrite files in a non-empty target directory. The default is the tested `v0.1.0` Starter release, so the same CLI version produces the same Starter revision. Use `--ref` to explicitly select a tag, branch, or commit.

The default is the tested Starter release tag `v0.1.0`. Every generated project records its CLI version, Starter repository, and exact Starter ref in `package.json` and `README.md`.

## How it works

This first CLI release scaffolds the complete reference starter. It does not yet offer selectable SaaS, dashboard, or minimal feature presets; those should be added once each preset has a distinct, maintained template. This keeps CLI output aligned with the reference repo instead of creating a second, drifting copy of its source.

## Development

```sh
corepack enable
pnpm install
node ./bin/create.mjs --help
pnpm check
pnpm test
```

CI scaffolds a clean project from the pinned Starter release, installs its dependencies, runs linting, typechecking, unit tests, browser checks, and a production build, then starts the generated app and checks the landing page, sign-up page, dashboard, health endpoint, logo, and favicon. A scheduled, non-blocking compatibility job also checks Starter `main`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull request guidance. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Copyright 2026 Clubedge Digital Systems. Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
