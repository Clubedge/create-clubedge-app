# Changelog

All notable changes to `create-clubedge-app` are documented here.

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
