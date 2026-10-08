# Contributing

Contributions to `create-clubedge-app` are welcome. The CLI scaffolds the [Clubedge Starter](https://github.com/yassine-ahmed/clubedge-starter); keep it aligned with that reference implementation and avoid maintaining a duplicate project template in this repository.

## Development

Requirements are Node.js 22.12 or newer and pnpm 10.9 or newer.

```sh
corepack enable
pnpm install
node ./bin/create.mjs --help
pnpm check
```

## Pull requests

- Keep changes focused and explain the user-facing behavior.
- Update the README when options, generated files, or requirements change.
- Do not add options that do not change the generated project.
- Preserve the safety rule that non-empty target directories are never overwritten.
- Include appropriate verification for changes to argument parsing, download behavior, and project customization.
- Do not commit generated projects, credentials, or local environment files.

Contributions submitted for inclusion are licensed under the project's Apache License, Version 2.0, as described in section 5 of [LICENSE](LICENSE). No separate contributor license agreement is currently required.
