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
| 21 | 0.24.0 | Default to Starter v0.17.0 |

## CLI improvements

These are independent of the Starter's modules and can land in any order.

- **Incoming version of a conflicted file:** after `add`, `remove`, or `upgrade`, offer the Starter's version of each conflicted file (the target render) next to yours, for comparing by hand.
- **Interactive several-module changes:** let the `add` menu pick more than one module before applying them together.
