# Changelog

All notable changes to `create-clubedge-app` are documented here.

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
