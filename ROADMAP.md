# Roadmap

This roadmap describes the CLI's releases since 0.5.0 and the work planned next. The Starter side of the same phases, the modules themselves, lives in the [Starter roadmap](https://github.com/Clubedge/clubedge-starter/blob/main/ROADMAP.md). Each phase ends with a Starter release and a CLI release pinned to it.

## Done

| Phase | Release | What it delivered |
| --- | --- | --- |
| 4 | 0.5.0 | `--auth`, `--storage`, `--cache`, template schema 3, conditional blocks, lockfile pruning |
| 5.1 | 0.6.0 | `--infra`, module-defined root scripts, Windows tag verification fix |
| 5.2 | 0.7.0 | `--infra local`, pruning of optional peer links |
| 5.3–5.4 | 0.8.0 | `add`, `remove`, and `upgrade` with a three-way merge, drive-root fix |
| 6 | 0.9.0 | Menus for `add` and `remove`, `pnpm clubedge` in messages, Windows CI |
| Before 7 | 0.10.0 | Module flags, help text, and the customize prompt from the Starter's manifest, so new modules need no CLI release |
| 7 | 0.10.0 | `--email`, and a fix for doubled blank lines in `.env.local` when a module's variables are swapped |
| 8 | 0.11.0 | `--deploy`, with Fly.io and Vercel projects in CI and a Netlify project in the release smoke test |
| 9 | 0.12.0 | `--payments`, tested in CI, in the release smoke test, and by `add payments stripe` |
| 10.1 | 0.13.0 | `--jobs`, and a fix for lockfile entries left empty when an optional peer is pruned |
| 10.2 | 0.14.0 | `--observability` |
| 11 | 0.15.0 | `status` and `doctor`, several modules in one change, conflict and upgrade summaries, macOS CI, a 15-minute npm wait in the release workflow |
| 13 | 0.16.0 | Starter v0.14.0: account settings page, browser error reporting and Sentry source maps, auth emails through the jobs queue |
| 14 | 0.17.0 | Starter v0.15.0: docs-style dashboard with a sidebar, account card, and phone drawer |
| 15 | 0.18.0 | `try` on a free Railway VM (experimental), on Starter v0.15.0 |
| 16 | 0.19.0 | `try` inside a project uploads it; the preview opens in the browser |
| 17 | 0.20.0 | Conflicts: the Starter's version of each conflicted file, several modules at once; `try`: claim to share, `--claim`, `--status`; CI on Node 24 actions and Ubuntu 24.04, automatic release pages |
| 18 | 0.21.0 | Starter v0.16.0 (upgrades as pull requests, Node 24 actions, steadier tests); `pnpm release` and the Starter pin workflow; CI names a generated project's failing check |
| 19 | 0.22.0 | `deploy` to Railway (project, databases, variables, domain, release); Starter v0.16.1: faster Docker builds |
| 20 | 0.23.0 | `deploy` writes and applies `.railway/railway.ts` (Railway's configuration as code) instead of `railway.json` |
| 21 | 0.24.0 | Starter v0.17.0: `.railway/railway.ts` instead of `railway.json`, ahead of Railway's 2026-12-01 cutoff |
| 22 | 0.25.0 | `deploy` for Fly.io (experimental); Dependabot for the CLI and the Starter |
| 23 | 0.26.0 | `deploy` with your own databases from the env file; a `try` walkthrough in the showcase |
| 24 | 0.27.0 | Starter v0.18.0: `check:env` stops Vercel and Netlify builds on a missing production variable |
| 25 | 0.28.0 | `deploy` to Vercel (experimental) |
| 26 | 0.29.0 | `deploy` to Netlify and Render (experimental) |
| 27 | 0.30.0 | Starter v0.19.0: `--infra neon` creates a free Neon database, the `neon` command, `DATABASE_URL_DIRECT` for migrations and jobs |
| 28 | 0.30.0 | `deploy --preview` for Vercel and Railway with a Neon branch per preview; Starter: a preview environment for each pull request |
| 28 | 0.30.1 | Starter v0.19.1: Railway previews fixed after running for real (workspace tokens, `PORT`), both preview URLs in the comment; tested end to end on Vercel and Railway |
| 29 | 0.31.0 | Starter v0.20.0: pluggable jobs, with `--jobs bullmq` (Redis) and `--jobs inngest` next to pg-boss, and `@clubedge/jobs/conformance`, which every provider passes |
| 30 | 0.32.0 | Starter v0.21.0: pluggable auth, with `--auth firebase` (Auth Emulator in development) and `--auth appwrite` (Cloud or self-hosted), and `@clubedge/auth/conformance`, which every provider passes |
| 31 | 0.33.0 | Starter v0.22.0: stack packs (template schema 4), and a React + Vite frontend with a separate Hono API (`--framework vite --api hono`) |
| 32 | 0.34.0 | Starter v0.23.0: a FastAPI API in Python (`--framework vite --api fastapi`), generated with no CLI change |
| 33 | 0.35.0 | `deploy` for a frontend and its API (Docker Compose, Railway); Starter v0.24.0: all four auth providers on React + Vite with Hono or FastAPI |
| 34 | 0.36.0 | Starter v0.24.1: security update of FastAPI's `certifi`; dependency updates |
| 35 | 0.37.0 | An MCP server (capabilities, validate, plan, create) and an agent skill for coding agents |
| 36 | 0.38.0 | Starter v0.24.2: Next.js security update (critical RCE advisories); database URLs, Neon, and deploy variables for a frontend and its API |
| 37 | 0.39.0 | Starter v0.25.0: every module on React + Vite with Hono, and account settings on React + Vite |
| 38 | 0.40.0 | Starter v0.26.0: every module on React + Vite with FastAPI (pg-boss excepted) |
| 39 | 0.41.0 | Skip pnpm install and explain a package.json with conflict markers; Detect unresolved conflict markers in doctor; Preserve project version and custom README across upgrades (Phase 2); Conflict on a pnpm override now that projects own their version |

## CLI improvements

These are independent of the Starter's modules and can land in any order.

- **MCP progress during installs:** `create_project` with `install_dependencies` runs `pnpm install` and toolchains such as `uv sync`, which can outlast an MCP client's request timeout. Send progress notifications while they run.
