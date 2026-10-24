# Stack packs

A Starter describes itself to the CLI in packs (template schema 4, and schema 5 for the `shell`
role). Each part is described in one place, so adding a stack, in any language, adds a folder
and changes nothing shared.

```text
clubedge.template.json            the project: slots, the module order, shared conditional files
clubedge/modules/<id>.json        a module: its options, packages, scripts, and shared files
apps/<name>/clubedge.stack.json   a stack: its role, and its own files for each module option
```

The CLI leaves every descriptor out of generated projects.

## Slots and roles

A slot is a place for one app in generated projects. The Starter declares:

| Slot        | Path         | Roles                   | Flag          |
| ----------- | ------------ | ----------------------- | ------------- |
| `framework` | `apps/web`   | `fullstack`, `frontend` | `--framework` |
| `api`       | `apps/api`   | `api`                   | `--api`       |
| `shell`     | `apps/shell` | `shell`                 | `--shell`     |

A slot may also name `packages` only its apps use (the API contract, for example), left out
when it is empty, and its own `siteConfig`, which the CLI names after the project like the
framework's.

A stack has one role, which puts it in one slot. A slot without a `default` is optional:
`--api none` leaves it empty. The roles must fit together: a `frontend` calls an API, so it
needs an `api` stack, and a `fullstack` app has its own server, so it takes none. A `shell`
packages a frontend's static build as a mobile app (Capacitor, for Android and iOS), so it
needs a `frontend`, which still needs its API; a `fullstack` app renders its pages on its
server, so no shell can package it. The CLI asks for the slots in their order, offering only
the stacks that fit the answers so far.

`clubedge:if` and `clubedge:only` conditions name a slot by its id, like a module:
`shell!=none`, or `framework=vite && shell=capacitor`.

## A stack descriptor

```json
{
  "id": "next",
  "name": "Next.js",
  "role": "fullstack",
  "envExample": "../../.env.example",
  "dockerfile": "../../Dockerfile",
  "deployment": { "id": "web", "port": 3000, "healthPath": "/api/health", "platforms": ["docker", "railway"] },
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
- `deployment` (optional) records a service id, listening port, health path, and supported deploy
  platforms. The CLI records these facts by slot in `package.json` under `clubedge.services`.
  `deploy` uses them to render Docker Compose or Railway services, preserving the API as a private
  service behind the frontend proxy.

## Stacks without a server

A `shell` stack packages another app's build and runs no server, so neither it nor its slot has
a `dockerfile`, and it declares no `deployment`; the CLI refuses a shell's descriptor that names
either. The rest works as for other stacks: its folder moves to the slot's path, its
`envExample` to the slot's `env.example`, and the slot's `package` names it.

```json
{
  "id": "capacitor",
  "name": "Capacitor",
  "role": "shell",
  "envExample": ".env.example"
}
```

The `shell` slot has no `default`, so a project has no shell unless `--shell` asks for one.
Since a shell declares no deployment, it is never one of a project's `clubedge.services`:
`deploy` builds and runs the frontend and the API, and leaves the shell out. Like a frontend, a
shell lists only the modules it takes part in.

## Module scope

A module is `"scope": "app"` (the default) when apps implement it, such as authentication or
storage, and `"project"` when it is about the project as a whole, such as local infrastructure
or deployment.

For an app module, the selected option must be implemented by every selected stack that lists
the module, and by at least one. A module left to its default uses the first option the
stacks implement when they don't implement the default. A full-stack stack implements every
option; a frontend lists only the modules it takes part in, and an API lists what it
implements so far (at least one option of each app module).

For modules shared by a frontend and API, each selected stack contributes its own part. The Vite
Supabase option owns the browser session and adds its access token to contract requests. The Hono
and FastAPI Supabase options verify that token server-side and normalize the user to the contract's
`User` type. Only the publishable key is sent to the browser; provider secrets stay in the API env.

## Deployment services

Stacks can declare deployment facts without teaching the CLI stack-specific rules:

```json
"deployment": {
  "id": "api",
  "port": 3001,
  "healthPath": "/api/health",
  "platforms": ["docker", "railway"]
}
```

The CLI records the selected services under `package.json` → `clubedge.services`. For Docker, it
uses each app's Dockerfile to write a Compose topology: the frontend is public and proxies `/api`
to the private API service. For Railway, it creates a public frontend service and a private API
service, configures their health checks and API migrations, and connects them over Railway's
private network. The generated `.railway/railway.ts` is the source of truth for those service
settings.

## Adding a stack

1. Add `apps/<name>/` with the app, its `package.json` scripts, `.env.example`, `Dockerfile`
   (unless it is a shell), `clubedge.stack.json`, and its deployment service facts where
   applicable.
2. Implement the module options it supports, as files in its folder, and list them.
3. Run the Starter's `scripts/template-manifest.test.ts`, then generate a project with
   `--template-dir` and run its checks.

Nothing else changes: not the CLI, not the other stacks, not the module descriptors.

## Schema 5

Schema 5 is schema 4 with the `shell` role; nothing else changes. A Starter that offers a shell
declares schema 5, so a CLI that predates the role refuses it and asks to be updated instead of
failing on an unknown role. Schema 4 manifests are read as before, without the role.

## Older Starters

Starters with schema 1 to 3 (one `clubedge.template.json` listing every file) are read into
the same model: each framework becomes a full-stack stack in the `framework` slot that
implements every option. Projects created from them still add, remove, and upgrade.
