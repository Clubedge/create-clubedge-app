# Stack packs

A Starter describes itself to the CLI in packs (template schema 4). Each part is described in
one place, so adding a stack, in any language, adds a folder and changes nothing shared.

```
clubedge.template.json            the project: slots, the module order, shared conditional files
clubedge/modules/<id>.json        a module: its options, packages, scripts, and shared files
apps/<name>/clubedge.stack.json   a stack: its role, and its own files for each module option
```

The CLI leaves every descriptor out of generated projects.

## Slots and roles

A slot is a place for one app in generated projects. The Starter declares:

| Slot        | Path       | Roles                   | Flag          |
| ----------- | ---------- | ----------------------- | ------------- |
| `framework` | `apps/web` | `fullstack`, `frontend` | `--framework` |
| `api`       | `apps/api` | `api`                   | `--api`       |

A stack has one role, which puts it in one slot. A slot without a `default` is optional:
`--api none` leaves it empty. The roles must fit together: a `frontend` calls an API, so it
needs an `api` stack, and a `fullstack` app has its own server, so it takes none.

## A stack descriptor

```json
{
  "id": "next",
  "name": "Next.js",
  "role": "fullstack",
  "envExample": "../../.env.example",
  "dockerfile": "../../Dockerfile",
  "conditional": ["next.config.ts"],
  "modules": {
    "auth": {
      "supabase|better-auth|firebase|appwrite": { "files": ["src/app/login"] },
      "better-auth": {
        "replace": { "src/server/auth.ts": "src/server/variants/auth.better-auth.ts" }
      },
      "none": { "replace": { "src/server/auth.ts": "src/server/variants/auth.none.ts" } }
    },
    "storage": { "s3|supabase": { "files": ["src/server/storage.ts"] }, "none": {} }
  }
}
```

- Paths are relative to the stack's folder. The selected stack's folder moves to its slot's
  path; its `envExample` and `dockerfile` move to the slot's.
- `modules` says which options the stack implements: every option named in a key, even one
  with nothing of its own (`"none": {}`). A key can name several options that share files.
- `files` are kept only when a selected option owns them; `replace` copies a variant over the
  default file when its option is selected.
- `conditional` lists the stack's files with `clubedge:if` blocks.
- `toolchain` (optional) installs the app's own dependencies after `pnpm install`, for stacks
  outside Node.js:

  ```json
  "toolchain": { "name": "uv", "check": ["uv", "--version"], "install": ["uv", "sync"], "url": "https://docs.astral.sh/uv/" }
  ```

  Every app still has a `package.json` with `dev`, `build`, `lint`, `typecheck`, and `test`
  scripts (calling its own tools), so the workspace runs every app the same way.

## Module scope

A module is `"scope": "app"` (the default) when apps implement it, such as authentication or
storage, and `"project"` when it is about the project as a whole, such as local infrastructure
or deployment.

For an app module, the selected option must be implemented by every selected stack that lists
the module, and by at least one. A module left to its default uses the first option the
stacks implement when they don't implement the default. A full-stack stack implements every
option; a frontend lists only the modules it takes part in, and an API lists what it
implements so far (at least one option of each app module).

## Adding a stack

1. Add `apps/<name>/` with the app, its `package.json` scripts, `.env.example`, `Dockerfile`,
   and `clubedge.stack.json`.
2. Implement the module options it supports, as files in its folder, and list them.
3. Run the Starter's `scripts/template-manifest.test.ts`, then generate a project with
   `--template-dir` and run its checks.

Nothing else changes: not the CLI, not the other stacks, not the module descriptors.

## Older Starters

Starters with schema 1 to 3 (one `clubedge.template.json` listing every file) are read into
the same model: each framework becomes a full-stack stack in the `framework` slot that
implements every option. Projects created from them still add, remove, and upgrade.
