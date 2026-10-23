# Changelog

All notable changes to `create-clubedge-app` are documented here.

## 0.37.0

- **An MCP server for coding agents** (#110): `create-clubedge-app-mcp`, in the same package, lets an agent create projects with the CLI's pinned Starter and its compatibility rules. Run it from the workspace where projects should go:

  ```sh
  npx -y --package @clubedge/create-clubedge-app create-clubedge-app-mcp
  ```

  - `get_starter_capabilities` lists the frameworks, API stacks, modules, defaults, and what each option requires.
  - `validate_project_config` checks a choice of stacks and modules.
  - `plan_project` previews a project: the stacks and modules, the files, the environment files, toolchains such as uv, and the setup steps. It writes nothing.
  - `create_project` writes the project to a new or empty folder beneath the server's working directory. It refuses absolute paths, `..`, and symlinks that lead outside. Git and dependency installation are off unless asked for, and their output goes to stderr, never into the MCP stream.
- **An agent skill**, `skills/clubedge-starter/SKILL.md`, in the package: it tells Codex, Claude Code, and other agents to plan before creating, to use `add`, `remove`, and `upgrade` for existing projects, and to fall back to the CLI without MCP. The README shows how to install it and connect the server.
- CI and the release workflow start the MCP server from the packed package and call every tool.
- Still on Starter `v0.24.1`.

## 0.36.0

- **Security: default to Starter `v0.24.1`** (#107). It updates the FastAPI API's locked `certifi` to 2026.10.19, for the critical advisory [GHSA-6q48-6c7w-9gw2](https://github.com/certifi/python-certifi/security/advisories/GHSA-6q48-6c7w-9gw2). If your project has `--api fastapi`, run `pnpm clubedge upgrade`, then `uv sync` in `apps/api`. The Starter's pull request previews also skip secret-backed deploys for Dependabot.
- Dependency updates: giget 3.3.1 (#69), vitest 5.0.5 (#104), and @types/node 26.6.5 (#68).

## 0.35.0

- **Deploy a frontend and its separate API** (#103):
  - `--deploy docker` generates a Compose setup with the Vite frontend and API as separate services. The frontend is public; the API stays on the internal network, and the generated configuration includes each service's port and health check.
  - `--deploy railway` provisions the frontend and API services, wires the frontend to the private API URL, configures service variables, and runs database migrations before releasing the API.
  - Deployment capabilities now live in each stack's descriptor, including supported platforms, ports, and health checks. See [docs/stack-packs.md](docs/stack-packs.md).
- **Default to Starter `v0.24.0`** (#105), which brings all four auth providers to React + Vite with either Hono or FastAPI:
  - Supabase, Better Auth, Firebase, and Appwrite each have frontend flows and API-side token or session verification.
  - Generated-project and auth-flow CI covers every provider with both APIs; Docker and Railway deploy configuration is checked for both combinations.
  - FastAPI now has a committed `uv.lock` for reproducible Python installs. Pull request previews can also deploy the Vite frontend and API as separate Render services.

## 0.34.0

- **A FastAPI API**: default to Starter `v0.23.0` (#101). `--framework vite --api fastapi` creates the React + Vite frontend with an API in Python, managed with [uv](https://docs.astral.sh/uv/):
  - The Starter added it as one folder that describes itself, and this CLI generates it without a code change: the API lands in `apps/api` as `@clubedge/api`, and the CLI runs `uv sync` after `pnpm install`.
  - Its `package.json` scripts call uv, ruff, mypy, and pytest, so `pnpm dev`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` run it like the other apps. `pnpm lint` and `pnpm test` now also run each app's own scripts, so apps in other languages are always checked.
  - It passes the same contract suite as the Hono API, against the live server, through `clubedge-contract-check`.
  - A first version: the app modules are `none` (cache: memory, deploy: Docker). Install uv first.
- CI generates the pair from the packed CLI. The smoke check waits for a separate API that starts after its frontend (#100).

## 0.33.0

- **A frontend and a separate API**: default to Starter `v0.22.0` (#98). `--framework vite --api hono` creates a React + Vite frontend in `apps/web` and a Hono API in `apps/api`, joined by one HTTP contract:
  - `packages/contract/openapi.yaml` is the contract. The frontend calls the API only through the client generated from it, and `@clubedge/contract/conformance` is the test suite every API passes, in process or over HTTP against any running API.
  - `pnpm dev` and `pnpm start` run both, and the frontend forwards `/api` to the API, so the browser sees one origin. `docker compose up --build` runs both images.
  - A first version: on these stacks the modules are `none` (cache: memory, deploy: Docker). `deploy` explains that it sets up one app and doesn't deploy the pair yet (#96).
  - CI generates the pair from the packed CLI and runs its full pipeline; the smoke check accepts a single-page app's shell for a missing page (#97).
- **Stack packs** (template schema 4, #95): a Starter describes each app in its own `clubedge.stack.json` and each module in `clubedge/modules/<id>.json`, so adding a stack adds a folder and changes nothing shared. See [docs/stack-packs.md](docs/stack-packs.md).
  - Slots place apps in generated projects: `--framework` for the web app and `--api` for a separate API. A frontend needs an API, and a full-stack app takes none.
  - The CLI checks that the selected stacks implement each chosen module option, and only offers those options in prompts and `add`.
  - Stacks outside Node.js declare a toolchain, such as uv, whose install runs after `pnpm install`.
  - A slot can name packages only its apps use, left out when it is empty, and its own site config, named after the project (#96).
  - Starters with schema 1 to 3 are read into the same model, so projects created from them still add, remove, and upgrade. Projects generated from the same selection are byte-identical to 0.32.0.

## 0.32.0

- **Pluggable authentication**: default to Starter `v0.21.0` (#93). Authentication now has four providers behind one interface, so the pages, settings, payments, and jobs stay the same whichever signs users in:
  - `--auth supabase` and `--auth better-auth`, as before.
  - **`--auth firebase`** (new): Firebase Authentication from the server, with session cookies. `pnpm auth:dev` starts the Auth Emulator, so development needs no Firebase account. Reset and confirmation emails go through the app's email module.
  - **`--auth appwrite`** (new): Appwrite accounts on Appwrite Cloud or your own server, with session cookies and an API key. Appwrite sends its own emails.
  - `@clubedge/auth/conformance` is one test suite every auth provider passes: sign-up and sign-in, sign-out, reset through the emailed link, password changes that sign out other sessions, and account deletion. The Starter's CI runs it against all four, including Appwrite Cloud.
  - Stripe payments work with every provider.
  - Switch an existing project with `pnpm clubedge add auth firebase` or `pnpm clubedge add auth appwrite`. After `pnpm clubedge upgrade`, run `pnpm db:migrate`: `users.auth_user_id` becomes text, since Firebase's and Appwrite's user ids aren't UUIDs.

## 0.31.0

- **Pluggable background jobs**: default to Starter `v0.20.0` (#91). The jobs module now has three providers behind one interface, so job definitions, routes, and the dashboard's jobs card stay the same whichever runs them:
  - `--jobs pg-boss`: jobs in your PostgreSQL, run by a worker in the app server.
  - **`--jobs bullmq`** (new): jobs in Redis through BullMQ 6, run by a worker in the app server. It needs `--cache redis`, so `deploy` creates Railway's Redis with it.
  - **`--jobs inngest`** (new): Inngest calls the app's `/api/inngest` to run each job, so serverless hosts need no cron. `pnpm jobs:dev` starts its Dev Server, and `check:env` requires `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` in production.
  - `@clubedge/jobs/conformance` is one test suite every provider passes: retries, delays, throttling, timeouts, history, and the worker. SETUP.md shows how to add your own provider with it.
  - `runDue`'s `failed` now counts every failed attempt, retries included, for every provider.
  - Switch an existing project with `pnpm clubedge add jobs bullmq` or `pnpm clubedge add jobs inngest`.
- The showcase's SaaS walkthrough waits for Stripe's billing portal to be on screen before moving on (#90). Stripe renders the portal's text under a spinner and fades it in, which Playwright counted as visible.

## 0.30.1

Railway previews, fixed after running them for real on the Starter's own pull requests.

- `deploy --preview` sets `PORT` on the Railway preview environment (#87). The preview's domain sends traffic to port 3000, but a production service without `PORT` gave the copied environment none: Railway assigned its own port, and the app answered 502.
- Default to Starter `v0.19.1` (#88), which fixes the Railway step of `.github/workflows/preview.yml`:
  - It works with a workspace token as well as an account token: it no longer runs `railway link`, which needs an account token, since the Railway CLI targets the project from `RAILWAY_PROJECT_ID`.
  - It sets `PORT=3000` on the pull request's environment, for the same reason as above.
  - The pull request comment lists the Vercel and Railway apps separately when both deploy.
  - Tested on the Starter's pull requests: a Neon branch with the migrations, a Vercel and a Railway preview each answering `/api/ready`, and cleanup of the branch and the Railway environment on merge.
- If your project deploys previews to Railway, run `pnpm clubedge upgrade` to get the fixed `preview.yml`.

## 0.30.0

- **`--infra neon`** gives a project a hosted Neon database with nothing to install and no account (#84):
  - The CLI creates a free database through Neon's claimable Postgres. It writes the pooled `DATABASE_URL` and the direct `DATABASE_URL_DIRECT` into `apps/web/.env.local`, and the next steps include `pnpm db:migrate`.
  - Neon keeps an unclaimed database for 72 hours. `--no-neon` creates nothing, and a project is still created when Neon can't be reached.
  - `pnpm clubedge add infra neon` switches an existing project and creates a database when `DATABASE_URL` still held the old infrastructure's example value.
- **`pnpm clubedge neon`** shows the database's status and hours left (#84):
  - `neon claim` opens Neon's page that moves it into your free Neon account. Claiming resets the password, and the CLI says where to copy the new connection strings from.
  - `neon create` makes a new database, for example after one expired.
- **`doctor`** checks the database URLs (#84): pooled for the app, direct without `-pooler`, both for the same database. It also warns when a free database has less than a day left.
- **`deploy`** sends `DATABASE_URL_DIRECT` with a `DATABASE_URL` from the env file, and derives it from a pooled Neon URL when the file has none. It never sends one next to the platform's own database, repoints one left from an earlier database, and warns before deploying a database that is still unclaimed (#84).
- **`deploy --preview`** deploys the current Git branch next to production on Vercel (a preview deployment) or Railway (an environment copied from production) (#84):
  - With `NEON_API_KEY` and `NEON_PROJECT_ID`, the preview gets its own Neon branch, `preview/<git branch>`, with this branch's migrations applied.
  - On Vercel, the branch's URLs are set as Preview variables of the Git branch, which needs the Vercel project connected to its Git repository.
- **`try --infra neon`** creates the database on your machine and migrates it on the VM. An uploaded Neon project sends its two URLs (#84).
- Default to Starter `v0.19.0` (#85). It adds `infra neon`, the optional `DATABASE_URL_DIRECT` that migrations and the jobs worker use, and a preview environment with its own Neon branch for each pull request.

## 0.29.0

- `pnpm clubedge deploy` deploys to Netlify and Render (experimental) (#82), so it now covers Railway, Fly.io, Vercel, Netlify, and Render:
  - Netlify: it signs in with `netlify login`, creates or reuses the site with `apps/web` as its base directory, imports the production variables from `.env.production`, the site URL, and a generated `BETTER_AUTH_SECRET`, then runs `netlify deploy --build --prod`. The build runs on your machine with the site's variables.
  - Render: it signs in with an API key (`RENDER_API_KEY`, or pasted from the dashboard page it opens) and builds from your pushed Git branch. It creates or reuses a Docker web service that runs the migrations before each release and checks `/api/health`, as `render.yaml` does, on a starter instance, since pre-deploy commands need a paid type. It sets the variables and waits until the deploy is live.
  - On both, `DATABASE_URL` comes from your provider (Neon, Supabase, ...).
- Still on Starter `v0.18.0`.

## 0.28.0

- `pnpm clubedge deploy` deploys to Vercel (experimental) (#80), in projects created with `--deploy vercel`:
  - It signs in with `vercel login` when you are signed out, then creates or reuses the project with `apps/web` as its Root Directory and writes `.vercelignore` so `.env` files stay on your machine.
  - It sets the production variables from `.env.production` (or `--env-file`), the public URL, and a generated `BETTER_AUTH_SECRET`, then runs `vercel deploy --prod`. `DATABASE_URL` must point at your provider (Neon, Supabase, ...), since Vercel only runs the app.
  - When Vercel names the app something other than `<project>.vercel.app`, it sets that URL and deploys again, since the build compiles it in.
- The README opens with the banner the CLI prints (#79).
- Still on Starter `v0.18.0`.

## 0.27.0

- Default to Starter `v0.18.0` (#77), which stops Vercel and Netlify builds when a production variable is missing:
  - On those hosts the platform only runs the app, and the database, Redis, storage, and email come from your providers. `pnpm check:env` now runs first in the build command of `vercel.json` and `netlify.toml`, before migrations.
  - It lists each variable the project's modules need that is unset, points at `localhost`, or isn't an absolute URL, and stops the build. That includes `.env.example`'s `example.com` sender in `EMAIL_FROM`.
  - Generated projects check only their own modules. `SKIP_ENV_CHECK=1` builds anyway.
- If you deploy to Vercel or Netlify: run `pnpm clubedge upgrade`, then set the variables for every environment you build (Production and Preview).

## 0.26.0

- `deploy` uses your own databases when the env file has their URLs (#74). The platform hosts everything as before when it doesn't.
  - With `DATABASE_URL` or `REDIS_URL` in the env file (Supabase, Neon, Upstash), `deploy` creates no Railway or Fly database for it, sets your URL, and the platform only runs the app. Each URL counts on its own, so only `DATABASE_URL` keeps Redis on the platform.
  - `deploy` reads `.env.production` from the project's root when there is one and no `--env-file` is given. An `--env-file` that doesn't exist is now a clear error.
  - URLs to `localhost` (a development env file) are ignored with a warning.
  - A later run without the env file keeps the database URL the service already has, instead of creating the platform's database and switching the app over. On Railway, `deploy` stops before changing anything if it can't list an existing service's variables. On Fly, an existing `DATABASE_URL` secret skips creating `<app>-db`.
  - When the app moves from Railway's database to its own, `deploy` notes that the old one is unused; it never deletes it.
- The showcase records a `try` walkthrough on a free Railway VM (#73).
- `pnpm release` counts squash-merged pull requests in the changelog draft (#75).
- Still on Starter `v0.17.1`.

## 0.25.0

- `deploy` for Fly.io (experimental) (#71): in a project with `deploy fly`, `pnpm clubedge deploy` uses Fly's CLI and your Fly login.
  - It creates or reuses the app (`fly launch`, which writes its name and region into `fly.toml`; commit it), an unmanaged Postgres app attached as `DATABASE_URL` (one `shared-cpu-1x` machine and a 1 GB volume), and Upstash Redis with `cache redis`.
  - It imports the secrets through stdin: the public URL `https://<app>.fly.dev`, a `BETTER_AUTH_SECRET` kept on later runs, and `--env-file` values; the ones still unset are listed before the build.
  - `fly deploy` builds the Dockerfile with `NEXT_PUBLIC_APP_URL` as a build argument, runs the migrations as the release command, and waits for the health checks.
  - Fly's Managed Postgres (from $38/month) is a manual choice: create and attach it before deploying.
- Weekly Dependabot updates for the CLI's npm dependencies and GitHub Actions (#67). The Starter gets the same, without passing it on to generated projects, which receive updates as upgrade pull requests.
- Still on Starter `v0.17.1`.

## 0.24.1

- Default to Starter `v0.17.1` (#65), which fixes deployed Next.js apps sending sign-in email links and Stripe return URLs to `http://localhost:3000`: the Dockerfile now takes `NEXT_PUBLIC_APP_URL` as a build argument, which Railway and Render pass from the service's variables. `pnpm clubedge deploy` already sets it on Railway.
- `deploy` lists the settings still unset before the build instead of after the release, and asks whether to deploy anyway (#64).
- No more Node DEP0190 warning on Windows: commands that need the shell get one quoted command line (#64).
- The showcase is re-recorded after each release (#63).

## 0.24.0

- Default to Starter `v0.17.0` (#61), which adds:
  - Railway configuration as code: projects that deploy to Railway get `.railway/railway.ts` (the migrations before each release, the `/api/health` check) instead of `railway.json`, which Railway stops reading on 2026-12-01. It names the service after the package, and `pnpm clubedge deploy` applies it before each release.
  - The deploy workflow on Railway CLI 5.
- If you deploy to Railway: run `pnpm clubedge upgrade`, then deploy once with `pnpm clubedge deploy` (or run `railway config apply`) before 2026-12-01.

## 0.23.0

- `deploy` moves Railway projects to `.railway/railway.ts`, Railway's configuration as code, which replaces `railway.json`: Railway stops reading `railway.json` on 2026-12-01 (#59).
  - When the project has no Railway configuration file, it writes one with the project's own names: the migrations before each release and the `/api/health` check, as in `railway.json`. Variables stay as `deploy` set them.
  - It adds Railway's TypeScript SDK (`railway`) as a dev dependency, and applies the file with `railway config apply` before each release. Commit `.railway/railway.ts`, `package.json`, and `pnpm-lock.yaml`.
  - It needs Railway CLI 5.42.1 or newer: an installed `railway`, else one npx already downloaded, and only then a download.
- Still on Starter `v0.16.1`.

## 0.22.0

- Add `deploy`: `pnpm clubedge deploy` does the first deploy of a project that uses `deploy railway`, with Railway's CLI and your Railway login (#55).
  - It asks first, then creates or reuses the Railway project, Postgres (and Redis with `cache redis`), the app's service, and a `*.up.railway.app` domain.
  - It sets the variables it can: the database references, `APP_URL` and `NEXT_PUBLIC_APP_URL`, `PORT`, and a generated `BETTER_AUTH_SECRET` that later runs keep. `--env-file .env.production` adds your provider keys; the ones still unset are listed.
  - It follows the deployment until Railway's final status: the migrations run before the release and `/api/health` is checked. On a failure it names the logs commands. Running it again reuses everything.
  - Railway only for now; `--dry-run` shows the plan.
- Default to Starter `v0.16.1` (#57): both Dockerfiles install dependencies in the build stage, so `node_modules` is no longer copied between stages, which made builds slow and timed out a first build on Railway.
- Release drafts list a Starter pin pull request once (#54).

## 0.21.0

- Default to Starter `v0.16.0` (#52), which adds:
  - Starter upgrades as pull requests: every project gets `.github/workflows/clubedge-upgrade.yml`, which checks every Monday for a newer Starter release and opens a pull request with `pnpm clubedge upgrade`'s result, the release notes, and anything left to resolve, so the project's own CI tests the upgrade before it is merged.
  - GitHub Actions on their Node 24 versions in `ci.yml` and `deploy.yml`, with Linux jobs on Ubuntu 24.04.
  - Steadier tests: PGlite starts once per test file, with room for slow CI runners.
- Release tooling for maintainers (#51): `pnpm release patch|minor|major` opens the release pull request with a drafted changelog, `pnpm release tag` publishes it, and the Starter pin workflow opens a pull request when the Starter publishes a release.
- CI names the generated project's failing check, in an annotation and the job summary (#50).

## 0.20.0

- Conflicts are easier to resolve after `add`, `remove`, and `upgrade`:
  - The Starter's whole new version of each conflicted file is saved in `.clubedge/incoming/<file>`, and the report prints a `git diff --no-index` command to compare it with yours. Files left for you to check by hand get theirs too, when the Starter has one. Git ignores the folder; each change replaces the previous change's files.
  - Without a module on the command line, the `add` and `remove` menus pick several modules at once; `add` then asks for each one's option, and the changes apply together.
- Sharing a `try` preview:
  - When the app is ready, `try` asks whether to share it. Claiming the VM, a free Railway sign-up, is what makes the URL work for anyone, so it opens the claim page. `--claim` does that without asking; scripts are never asked.
  - The closing message explains Railway's "Access denied" page and prints a port-forward command that opens the app at http://localhost:3000 from any network.
  - `try --status` shows the last VM's preview, time left, and claim link. It connects only while the VM is running, so it never creates a new one.
- Release workflow: GitHub Actions on their Node 24 versions, Linux jobs on Ubuntu 24.04, a sturdier wait for npm in the smoke tests, and GitHub Release pages created from this changelog.
- Still on Starter `v0.15.0`.

## 0.19.1

- `try` now says who can open the preview as Railway does: until the VM is claimed, only the IP address that created it. Another device on mobile data, a VPN, or anyone you send the link to gets Railway's "Access denied" page; claiming makes the URL shareable.
- Still on Starter `v0.15.0`.

## 0.19.0

- `try` inside a project: `pnpm clubedge try` uploads the project to a free Railway VM and runs it there, to share work in progress without deploying.
  - It uploads what Git would commit (tracked files, plus untracked ones that are not ignored), and never `.env` files other than examples, `node_modules`, or build output. If Git cannot list a repository's files, nothing is uploaded. `--dry-run` lists the files.
  - On the VM, the env file is made from `.env.example` as `create` does, then the database (infra `local`), migrations, and the app start as for a new project.
  - Projects that need Docker or Supabase Auth are refused, with the `pnpm clubedge add` command that switches them.
- `try` opens the preview in the browser when it is ready, at a terminal; `--no-open` turns that off.
- Still on Starter `v0.15.0`.

## 0.18.0

- Add `try` (experimental): `pnpm dlx @clubedge/create-clubedge-app try` creates a new project on a free, temporary [Railway VM](https://railway.com/free-vm) instead of your machine, and prints its preview URL and the link to claim the VM. No Railway account, database, or Docker needed.
  - The VM has no Docker, so the project uses `--infra local` (PGlite) and Better Auth, with email off; `--framework` and other module flags apply as usual. `--infra` other than `local` and `--auth supabase` are rejected.
  - It asks before creating anything (`--yes` agrees), keeps its own SSH key in the CLI's config directory apart from `~/.ssh`, and connects only to Railway's known host key (`CLUBEDGE_RAILWAY_HOST_KEY` adds one if Railway rotates it).
  - The VM lasts 60 minutes and can be claimed for 24 hours after; until then, the preview opens only from your network. Railway allows 3 free VMs per network per day.
- Still on Starter `v0.15.0`.

## 0.17.0

- Default to Starter `v0.15.0`, whose dashboard has the docs' layout and colors in both frameworks: a collapsible sidebar with a section switcher, the dashboard's sections, resources, and an account card with Settings and Sign out; the page in a rounded card that scrolls on its own; a top bar with Home, GitHub, and a light and dark switch; and a drawer on phones.
- None of this needs CLI code: it all comes from the Starter.

## 0.16.0

- Default to Starter `v0.14.0`, which adds:
  - An account settings page at `/settings` when an auth provider is selected: display name, password change (signing out other sessions), and account deletion. Supabase projects set `SUPABASE_SECRET_KEY` to allow deletion.
  - Browser error reporting with observability on: uncaught errors, unhandled rejections, and render errors caught by the new error pages, through `/api/client-errors` (`otel`) or Sentry's browser SDK (`sentry`). Sentry builds with `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT` upload source maps and then delete them.
  - Auth emails sent through the background-jobs queue, with retries, when both email and jobs are selected.
- None of this needs CLI code: it all comes from the Starter's manifest.

## 0.15.0

- Add `status`: a project's Starter release, framework, modules, and Git state, whether a newer Starter release exists (from npm, still working offline), and the command to run next.
- Add `doctor`: checks Node.js and pnpm against the project's versions, installed dependencies, the lockfile, and the env file against the example, then runs `pnpm check:services` (`--no-services` skips it). It exits with an error when a check fails.
- `add` and `remove` take several modules (`add email resend payments stripe`, `remove storage payments`) and apply them as one change, checking requirements after every change.
- After a change with conflicts, list each file with its number of conflict blocks.
- `upgrade` lists the Starter releases it crosses, with the sections of their release notes.
- Fix a finished command exiting with an error when Windows briefly locked the downloaded Starter's temporary folder.
- CI: test generated projects on macOS too; the release workflow waits up to 15 minutes for npm.

## 0.14.1

- Default to Starter `v0.13.1`. In projects with background jobs or observability, a configuration error such as a missing `DATABASE_URL` no longer stops the server at startup; pages that need no database keep working, and the error is reported once.

## 0.14.0

- Default to Starter `v0.13.0`, which adds observability (`--observability otel|sentry`): request tracing and server error reporting through OpenTelemetry, to any OTLP collector, or Sentry, behind provider-neutral hooks in `@clubedge/core`. `--observability` needs no CLI code: it comes from the Starter's manifest.
- Test an observability project in CI and in the release smoke test, and add the observability module in the change-modules job.

## 0.13.0

- Default to Starter `v0.12.0`, which adds background jobs (`--jobs pg-boss`): jobs stored in the project's PostgreSQL, run by a worker inside the app server, with retries and schedules, and `/api/jobs/run` for serverless hosts. `--jobs` needs no CLI code: it comes from the Starter's manifest.
- Fix generated lockfiles that pnpm rejected as broken when pruning an optional peer left a package with no dependencies, such as `pg-pool` once `pg` is pruned for `--jobs none`. Such entries are now written as `{}`, the way pnpm writes them.
- Test a jobs project in CI and in the release smoke test, and add the jobs module in the change-modules job.

## 0.12.0

- Default to Starter `v0.11.0`, which adds payments (`--payments stripe`): Stripe Checkout, the customer portal, and verified webhooks behind a provider-neutral payments interface. `--payments` needs no CLI code: it comes from the Starter's manifest.
- Test a payments project in CI and in the release smoke test, and add the payments module in the change-modules job.

## 0.11.0

- Default to Starter `v0.10.0`, which adds the deploy module (`--deploy docker|fly|railway|render|vercel|netlify`), a migrator in the production image, a manual deploy workflow, and the `/api/ready` readiness endpoint. `--deploy` needs no CLI code: it comes from the Starter's manifest.
- Test Fly.io and Vercel projects in CI and a Netlify project in the release smoke test.

## 0.10.0

- Default to Starter `v0.9.0`, which adds the email module (`--email smtp|resend|none`), password reset for both auth providers, and email verification for Better Auth. `--email` needs no CLI code: it comes from the Starter's manifest.
- Fix a doubled blank line in `.env.local` when `add` or `remove` swaps one section of variables for another, such as switching `--email smtp` to `resend`.
- Take module flags from the Starter's manifest: any `--<module> <option>` flag is accepted and validated against the modules the Starter describes, so new Starter modules need no CLI release. A mistyped module lists the Starter's modules; an unknown flag without a value is still an error.
- Build the help text's framework and module lines, and the "customize the included services" prompt, from the Starter's manifest.

## 0.9.0

- Default to Starter `v0.8.0`, whose projects have a `clubedge` script: `pnpm clubedge add`, `remove`, and `upgrade`.
- `add` and `remove` ask for the module and option when they are not given, offering only options the project can use. Without a terminal, missing arguments remain an error.
- Messages suggest `pnpm clubedge ...` in projects with the `clubedge` script, and the outro after creating a project mentions it.
- Test the CLI on Windows in CI: its checks and tests, and generated projects with a module change.

## 0.8.0

- Add `add <module> <option>` and `remove <module>` to change the modules of an existing project. The CLI renders the project's recorded Starter commit with the current and the new selection and merges the difference into the project. Files you never changed are updated, your edits are kept, and lines both sides changed get conflict markers. The local env file keeps your values: only generated values follow the new selection, and new variables are added. A Git repository without uncommitted changes is required unless `--force` is passed, so the result can be reviewed and undone.
- Add `upgrade [--ref <ref>]`, which moves an existing project to a newer Starter (this CLI's release by default) with the same merge as `add` and `remove`, and records the new revision. Modules the project predates start as `none` where the Starter offers it, and options the new Starter no longer offers are refused before anything changes.
- Record the commit of a Starter fetched with `--ref`, so projects created from a branch or tag can later be changed and upgraded.
- Fix creating a project directly under a Windows drive root, such as `D:\my-app`, which failed with EPERM.

## 0.7.0

- Default to Starter `v0.7.0`, which adds `--infra local`: PostgreSQL through PGlite and a local folder for files, so `pnpm dev` runs with nothing installed.
- Remove optional peer links to packages that only left-out modules installed, so generated projects no longer install them. For example, a project without `--infra local` no longer installs PGlite through drizzle-orm, and a project without Better Auth no longer installs its optional peers.

## 0.6.0

- Default to Starter `v0.6.0`, which adds the local infrastructure module and `pnpm check:services`.
- Add `--infra docker|supabase|none`: Docker Compose services, the Supabase CLI's local stack, or no local services. The environment examples point at the chosen services.
- Let module options set root `package.json` scripts; scripts that only left-out options define are removed, so each project gets the `infra:*` scripts for its option.
- Fix Starter tag verification on Windows, where an annotated tag resolved to the tag object instead of its commit and scaffolding a downloaded Starter release failed.

## 0.5.0

- Default to Starter `v0.5.0`, which adds optional modules, Better Auth, and template schema 3.
- Add `--auth`, `--storage`, and `--cache`, and offer to customize them interactively. Options whose requirements are not met (Supabase Storage without Supabase Auth) are refused with an explanation.
- Read template schema 3 modules: unselected options' packages, files, provider dependencies, environment variables, and lockfile entries are removed, and selected variants replace the default files.
- Process `clubedge:if` blocks in the Starter's documentation, environment examples, and sources, so a project only describes what it contains.
- Support Mermaid (`%%`) markers and single-line `clubedge:only` conditions, and leave no blank lines at file edges after removing blocks.
- Record the selected modules in the generated `package.json` and `README.md`. The smoke test skips the sign-up check for projects without authentication.

## 0.4.0

- Default to Starter `v0.4.0`, which adds the TanStack Start app and template schema 2.
- Add `--framework next|tanstack-start`, and ask which framework to use when the Starter offers several. Next.js stays the default.
- Read template schema 2, which describes each framework's app, environment example, and Dockerfile. The selected app is moved to `apps/web`, the others are left out, and `pnpm-lock.yaml` is kept in step so frozen installs work.
- Record the chosen framework in the generated `package.json` and `README.md`.
- Test generated projects for both frameworks in CI and in the release smoke test.

## 0.3.0

- Default to Starter `v0.3.0`, which adds the `clubedge.template.json` template manifest.
- Rewrite the CLI in TypeScript, organized into argument parsing, planning, execution, and steps.
- Bundle the pinned Starter release into the package. The default scaffold no longer downloads from GitHub or requires Git.
- Read the Starter's `clubedge.template.json` manifest and refuse Starters with a newer template schema.
- Add `--dry-run`, `--yes`, and `--template-dir`.
- Remove everything written when scaffolding fails, instead of leaving a partial project.
- Check the Node.js version before starting, and fall back to `corepack pnpm` when `pnpm` is not on the path.
- Never copy local environment files, dependencies, or build output from a template directory, even when it sits inside another Git repository.

## 0.2.1

- Publish the default Starter pin in the `clubedge` field of `package.json`. The CLI and release workflow read it from there, and the npm registry exposes it so the website always shows the Starter each CLI version scaffolds.
- Optionally trigger a website rebuild after a release when the `SITE_DEPLOY_HOOK` secret is configured.

## 0.2.0

- Default to Starter `v0.2.0`, which adds project identity in `site.json`, dashboard protection, rate-limited sign-in and sign-up, and lazy environment validation.
- Write the project name to `apps/web/src/config/site.json` when the Starter provides it, instead of replacing strings in source files. Starter `v0.1.x` refs keep the previous behavior.

## 0.1.13

## 0.1.12

- Install the published CLI's production dependencies before invoking it in the npm smoke test.

## 0.1.11

- Generate the published-package smoke-test project by extracting and invoking the exact npm tarball.
- Fail the generation step if the generated project manifest is missing.

## 0.1.10

- Make the published-package smoke test resilient to npm registry propagation delays by retrying the exact package tarball.

## 0.1.9

- Use npm Trusted Publishing with GitHub Actions OIDC for releases.
- Use an npm CLI version supported by Trusted Publishing and remove the token-based publish dependency.

## 0.1.8

- Correct the pinned Starter commit to the commit actually resolved by the immutable `v0.1.1` tag.

## 0.1.7

- Pin the default Starter reference to the tested `v0.1.1` release, including the corrected browser contract.

## 0.1.6

- Move the CLI and Starter repository references to the `Clubedge` GitHub organization.
- Update package metadata, documentation, tests, and generated provenance for the organization repositories.

## 0.1.5

- Verify the default Starter tag resolves to its expected commit and record that commit in generated metadata.
- Add a post-publish smoke-test workflow for the published npm package.

## 0.1.4

- Pin the default Starter reference to the tested release tag `v0.1.0`.
- Record the CLI version and Starter reference in generated project metadata and documentation.
- Add scheduled compatibility verification for the latest Starter `main` branch.
- Document the CLI-to-Starter version relationship and release workflow.

## 0.1.3

- Keep generated project-name customization aligned with the dashboard's route-local sidebar.
- Verify a fresh CLI-generated starter through install, typecheck, unit tests, production build, and HTTP smoke checks in CI.

## 0.1.2

- Customize the landing page, sidebar, dashboard, sign-in page, and metadata with the generated project name.
- Add automated tests for project naming and generated-file customization.

## 0.1.1

- Keep CLI spinners out of Git and pnpm subprocess output so terminal progress remains readable.

## 0.1.0

- Initial CLI release: scaffold the Clubedge Starter reference repository into a new project directory.
- Add project naming, environment file setup, optional dependency installation, Git initialization, and starter ref selection.
