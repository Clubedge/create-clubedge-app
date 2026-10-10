# Contributing

Contributions to `create-clubedge-app` are welcome. The CLI scaffolds the [Clubedge Starter](https://github.com/Clubedge/clubedge-starter); keep it aligned with that reference implementation and avoid maintaining a duplicate project template in this repository.

## Development

Requirements are Node.js 22.12 or newer and pnpm 10.9 or newer.

```sh
corepack enable
pnpm install
node ./bin/create.mjs --help
pnpm check
```

## Compatibility model

The CLI and Starter are separate projects with separate versions. The CLI must
use a tested, versioned Starter release by default; do not change the default
to `main`. For example:

```text
create-clubedge-app v0.5.0 -> clubedge-starter v0.5.0
```

The default Starter pin lives only in the `clubedge` field of `package.json`
(`starterRef` and `starterCommit`). The CLI, the release workflow, and the
website all read it from there, so a release only needs that field and
`version` updated. Get the commit with `git ls-remote https://github.com/Clubedge/clubedge-starter.git refs/tags/<tag>^{}`.

Use `--ref main` only for explicit compatibility experiments. A change to the
Starter's architecture, dependencies, authentication, database integration, or
shared UI requires a new Starter release and a generated-project verification
run before the CLI default is updated.

Generated projects must retain the provenance metadata written by the CLI:

```json
{
  "clubedge": {
    "cliVersion": "0.5.0",
    "starterRepository": "Clubedge/clubedge-starter",
    "starterRef": "v0.5.0",
    "starterCommit": "d9375c2c3b520323ff0255ef8ec65da19251c3c1"
  }
}
```

## Pull requests

- Keep changes focused and explain the user-facing behavior.
- Update the README when options, generated files, or requirements change.
- Do not add options that do not change the generated project.
- Preserve the safety rule that non-empty target directories are never overwritten.
- Include appropriate verification for changes to argument parsing, download behavior, and project customization.
- If changing the Starter reference or generated-project behavior, run the full generated-project verification described in the README.
- Do not commit generated projects, credentials, or local environment files.

Contributions submitted for inclusion are licensed under the project's Apache License, Version 2.0, as described in section 5 of [LICENSE](LICENSE). No separate contributor license agreement is currently required.
