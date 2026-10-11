# Roadmap

This roadmap describes the CLI work planned after 0.9.0. The Starter side of the same phases, the modules themselves, lives in the [Starter roadmap](https://github.com/Clubedge/clubedge-starter/blob/main/ROADMAP.md). Each phase ends with a Starter release and a CLI release pinned to it.

## Done

| Phase | Release | What it delivered |
| --- | --- | --- |
| 4 | 0.5.0 | `--auth`, `--storage`, `--cache`, template schema 3, conditional blocks, lockfile pruning |
| 5.1 | 0.6.0 | `--infra`, module-defined root scripts, Windows tag verification fix |
| 5.2 | 0.7.0 | `--infra local`, pruning of optional peer links |
| 5.3–5.4 | 0.8.0 | `add`, `remove`, and `upgrade` with a three-way merge, drive-root fix |
| 6 | 0.9.0 | Menus for `add` and `remove`, `pnpm clubedge` in messages, Windows CI |

## Before Phase 7: modules without CLI changes

Today every module flag is hard-coded (`MODULE_FLAGS` in `src/cli/args.ts`), and the help text and the "customize the included services" prompt name the four current modules. Each new Starter module would need a CLI change before anyone could select it.

- Accept `--<module> <option>` for any module the Starter's manifest describes. Parse flags leniently, then validate them against the manifest, which `selectModules` already does with helpful errors.
- Build the help text's module list and the customize prompt from the bundled Starter's manifest.
- Keep `MODULE_FLAGS` only as the list of flags known to older Starters, so unknown flags still fail fast for typos.

**Tests:** a fixture Starter with an extra module is selectable by flag, by prompt, and with `add`, with no CLI code naming it.

## Phase 7: Email

The CLI side is small once module flags come from the manifest.

- `--email resend|smtp|none` works without new flag code, and appears in help, prompts, and README tables.
- CI: generated-project entries for `--email smtp --auth better-auth` (Next.js) and `--email none` (TanStack Start). An `add email smtp` case joins the change-modules job.
- The release smoke test checks the recorded `email` option.

## Phase 8: Deployment

- `--deploy docker|vercel|fly|railway|none`, through the manifest.
- `upgrade` must handle platform config files that the developer edits a lot, such as `fly.toml`: they are merged like any file, and conflicts there should be reported with the platform's docs link.
- CI: generated-project entries per platform that check the config file is present and that the production build for that platform succeeds.

## Phase 9: Payments

- `--payments stripe|none`. The manifest's `requires` keeps payments off when `--auth none` is chosen, with the existing explanation in the error.
- `add payments stripe` must add the subscriptions migrations and say so in the outro (`pnpm db:migrate`), and append the Stripe variables to `.env.local` empty.

## Phase 10: Background jobs and observability

- `--jobs pg-boss|none` and `--observability sentry|otel|none`.
- `add jobs pg-boss` changes the `dev` script (a worker next to the app), which every option of the module must then set, as `infra` does today. The Starter's core-scripts test already guards this.

## CLI improvements

These are independent of the module phases and can land between them.

- **Release workflow:** wait up to 15 minutes for npm to serve a new version before the published-package smoke tests start. The 0.9.0 release needed a re-run after the 5-minute wait expired.
- **Several modules at once:** `add email smtp payments stripe`, or `change --email smtp --payments stripe`, applied as one merge so the project never sits in an in-between state.
- **`status`:** show the project's Starter version, modules, whether a newer Starter is available, and whether the working tree is clean. Ends with the command to run next.
- **`doctor`:** check Node.js and pnpm versions, the lockfile against `package.json`, the local env file against the example (missing or unused variables), and run `pnpm check:services`.
- **Conflict experience:** after `add`, `remove`, or `upgrade`, list each conflicted file with the number of conflict blocks, and print the command to see the incoming version of a file (the target render) for manual comparison.
- **macOS in CI:** a generated-project job on `macos-latest`, like the Windows one, so all three platforms are tested.
- **Upgrade summary:** print the release notes headings of every Starter release between the project's version and the target, so the developer knows what changed before reviewing `git diff`.
