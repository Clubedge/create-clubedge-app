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

## CLI improvements

These are independent of the Starter's modules and can land in any order.

- **Release workflow:** wait up to 15 minutes for npm to serve a new version before the published-package smoke tests start. The 0.9.0 release needed a re-run after the 5-minute wait expired.
- **Several modules at once:** `add email smtp payments stripe`, or `change --email smtp --payments stripe`, applied as one merge so the project never sits in an in-between state.
- **`status`:** show the project's Starter version, modules, whether a newer Starter is available, and whether the working tree is clean. Ends with the command to run next.
- **`doctor`:** check Node.js and pnpm versions, the lockfile against `package.json`, the local env file against the example (missing or unused variables), and run `pnpm check:services`.
- **Conflict experience:** after `add`, `remove`, or `upgrade`, list each conflicted file with the number of conflict blocks, and print the command to see the incoming version of a file (the target render) for manual comparison.
- **macOS in CI:** a generated-project job on `macos-latest`, like the Windows one, so all three platforms are tested.
- **Upgrade summary:** print the release notes headings of every Starter release between the project's version and the target, so the developer knows what changed before reviewing `git diff`.
