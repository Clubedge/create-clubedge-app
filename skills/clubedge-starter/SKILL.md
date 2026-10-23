---
name: clubedge-starter
description: Create and evolve applications based on Clubedge Starter with the create-clubedge-app CLI or MCP server. Use when asked to scaffold a Clubedge app, choose its framework or modules, validate a configuration, or change Starter modules in an existing generated project.
compatibility: Requires Node.js 22.12+ and pnpm 10.9+ to create projects. The MCP workflow requires the Clubedge Starter MCP server to be configured.
metadata:
  author: Clubedge
  repository: https://github.com/Clubedge/create-clubedge-app
---

# Clubedge Starter

Create and manage Clubedge Starter projects through the supported CLI or MCP tools. Follow the user's requested stack and services; do not add unrequested modules.

## Choose the interface

- If the `clubedge-starter` MCP server is available, call `get_starter_capabilities` first. Treat its response as authoritative for framework/API choices, module options, defaults, and requirements.
- Before scaffolding through MCP, call `plan_project` with the destination `directory` and requested `stacks` and `modules`. It validates compatibility and previews the files and setup actions without writing to disk. Resolve invalid combinations and any open choices before creating the project. Use `validate_project_config` when only a compatibility check is needed and no destination plan is useful.
- Use `create_project` to scaffold through MCP. Give `directory` as a relative path beneath the MCP server's working directory. Set `initialize_git` and `install_dependencies` to `true` only when appropriate for the user's request; both default to `false`.
- If MCP is unavailable, use the CLI. Prefer the installed project-local executable when present; otherwise use `pnpm dlx @clubedge/create-clubedge-app <directory> --yes` and provide the requested options as CLI flags.
- Use the CLI's `add`, `remove`, or `upgrade` commands for changes to an existing generated project. Do not reproduce those changes by manually copying Starter files.

## Scaffold a project

For a new app:

1. Identify the requested framework and API shape. Full-stack choices such as Next.js and TanStack Start do not use a separate API; Vite can be paired with Hono or FastAPI.
2. Choose only the requested modules. Check the live capabilities or CLI `--help` rather than relying on a hard-coded list, since each CLI release is pinned to a specific Starter release.
3. Validate that module requirements are met. For example, module compatibility can depend on the selected framework or another module.
4. Preview with the CLI's `--dry-run` when the requested changes or destination are unclear. For MCP, describe the exact target directory and options before creating if the user has not made them clear.
5. Create only in a new or empty directory. The MCP tool only accepts paths under its configured working directory. The CLI also refuses to overwrite an existing project.
6. Report the target path, selected stacks and modules, and any actions that still need to be run, such as dependency installation or starting local infrastructure. Relay the MCP result's `warnings` and `nextSteps`: with `infra: neon`, MCP creates no database, so the user runs `pnpm clubedge neon create` in the project (after `pnpm install`), then `pnpm db:migrate`.

CLI example:

```sh
pnpm dlx @clubedge/create-clubedge-app my-app --yes --framework next --auth better-auth --infra local
```

## Change an existing project

Run the CLI from the generated project directory:

```sh
pnpm clubedge add payments stripe
pnpm clubedge remove storage
pnpm clubedge upgrade
```

Check the project's Git state first. These commands preserve user edits and can report merge conflicts that need review. After a change, follow the CLI's instructions and run relevant checks, migrations, or service setup for the modules involved.

## Project guidance

- Keep secrets in the project's environment files and never print or commit secret values. With a separate API, the database URLs belong in `apps/api/.env.local`, since the API owns the database.
- Do not claim a project was created, installed, migrated, or deployed until the corresponding action succeeded.
- If an install or provider setup fails, report the exact failed step and the next command needed to resume; do not silently present a partially configured project as ready.
- Consult the generated `SETUP.md` and the official docs at https://starter.clubedge.live/docs for provider-specific configuration.
