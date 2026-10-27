# Stack packs

A Starter describes itself to the CLI in packs (template schema 4, schema 5 for the `shell`
role, and schema 6 for the `mobile` role). Each part is described in one place, so adding a
stack, in any language, adds a folder and changes nothing shared.

```text
clubedge.template.json            the project: slots, the module order, shared conditional files
clubedge/modules/<id>.json        a module: its options, packages, scripts, and shared files
apps/<name>/clubedge.stack.json   a stack: its role, and its own files for each module option
```

The CLI leaves every descriptor out of generated projects.

## Slots and roles

A slot is a place for one app in generated projects. The Starter declares:

| Slot        | Path          | Roles                   | Flag          |
| ----------- | ------------- | ----------------------- | ------------- |
| `framework` | `apps/web`    | `fullstack`, `frontend` | `--framework` |
| `api`       | `apps/api`    | `api`                   | `--api`       |
| `mobile`    | `apps/mobile` | `mobile`                | `--mobile`    |
| `shell`     | `apps/shell`  | `shell`                 | `--shell`     |

A slot may also name `packages` only its apps use (the API contract, for example), left out
when it is empty, and its own `siteConfig`, which the CLI names after the project like the
framework's. From schema 6, a slot that can be left empty may also name:

- `files`: Starter paths only its apps use, such as browser tests, left out when it is empty;
- `filesWhenEmpty`: Starter paths only used when it is empty, left out when it is filled, such
  as a mobile app's screen for the emailed links a website would otherwise open;
- `scripts`: root `package.json` scripts only its apps use, removed when it is empty;
- `fallback`: the slot whose package the root scripts filter on when it is empty. With
  `"fallback": "api"` on the framework slot, `pnpm dev` (`turbo run dev --filter=@clubedge/web`)
  starts the API in a project without a web app. Both slots name their `package`.

A stack has one role, which puts it in one slot. A slot without a `default` is optional:
`--api none` leaves it empty. A slot with a `default` can be optional too, with
`"optional": true` (schema 6): `--framework none` leaves the web app out of a project that is
only an API and its mobile app. The project records `none` for that slot, so `add`, `remove`,
and `upgrade` keep it empty instead of bringing the default back. A project needs a web app or
an API. The roles must fit together: a `frontend` calls an API, so it
needs an `api` stack, and a `fullstack` app has its own server, so it takes none. A `shell`
packages a frontend's static build as a mobile app (Capacitor, for Android and iOS), so it
needs a `frontend`, which still needs its API; a `fullstack` app renders its pages on its
server, so no shell can package it. A `mobile` app has its own native screens (Expo, for
Android and iOS) and calls the API, so it needs an `api` stack; a `fullstack` app has no
separate API for it to call. A project can have a shell and a mobile app at once. The CLI asks
for the slots in their order, offering only the stacks that fit the answers so far.

`clubedge:if` and `clubedge:only` conditions name a slot by its id, like a module:
`shell!=none`, `mobile=expo`, or `framework=vite && shell=capacitor`.

## Rules

From schema 6, `clubedge.template.json` can list the selections the Starter refuses, each a
condition written like a marker's, with the reason the CLI gives:

```json
"rules": [
  {
    "when": "framework=none && payments!=none",
    "message": "Without a web app, payments have no pages to send users back to: choose --payments none, or a web app."
  }
]
```

A rule counts once every slot and module it names has a value, so prompts and `add` only offer
what the rules allow given the answers so far, a default the rules refuse gives way to the first
option they allow, and a requested option they refuse fails with the rule's message. The CLI
refuses a rule that names a slot, stack, module, or option the Starter does not have.

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
- `conditional` lists the stack's files with `clubedge:if` blocks. A variant listed there has its blocks kept for the selection where it lands, over the default it replaces.
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
- `auditIgnores` (optional, schema 6) lists the advisories `pnpm audit` skips because of the
  stack's dependencies, such as one in a build tool that has no fix yet. The Starter's
  `package.json` lists them under `pnpm.auditConfig.ignoreGhsas`, and the CLI removes them from
  projects without the stack, which then audit every advisory:

  ```json
  "auditIgnores": ["GHSA-86w9-cpqp-85rv"]
  ```

## Stacks without a server

A `shell` stack packages another app's build, and a `mobile` stack is an app installed on
devices. Neither runs a server, so neither it nor its slot has a `dockerfile`, and it declares
no `deployment`; the CLI refuses a shell's or a mobile app's descriptor that names either. The
rest works as for other stacks: its folder moves to the slot's path, its `envExample` to the
slot's `env.example`, and the slot's `package` names it.

```json
{
  "id": "capacitor",
  "name": "Capacitor",
  "role": "shell",
  "envExample": ".env.example"
}
```

The `shell` and `mobile` slots have no `default`, so a project has neither unless `--shell` or
`--mobile` asks for one. Since they declare no deployment, they are never among a project's
`clubedge.services`: `deploy` builds and runs the frontend and the API, and leaves them out.
Like a frontend, a shell or a mobile app lists only the modules it takes part in, so a mobile
app that implements only some sign-in options limits `--auth` to those when it is selected.

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

An option's `packages` are workspace packages, left out with their folders when the option is
not selected. Its `dependencies` (optional) are packages from the registry that apps depend on
directly, only for this option, such as a native plugin: a native module links into an app
wherever it is a dependency, used or not, so projects without the option leave it out of every
`package.json` and of the lockfile's importers. A package another selected option lists stays.
CLIs before 0.46.0 ignore the field and keep the packages.

```json
"native": {
  "name": "FCM and APNs",
  "packages": { "@clubedge/push": "packages/push", "@clubedge/push-native": "packages/push-native" },
  "dependencies": ["expo-notifications", "@capacitor/push-notifications"]
}
```

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
uses each app's Dockerfile and port to write a Compose topology behind Caddy: the frontend is the
public service, which Caddy serves over HTTPS, and proxies `/api` to the private API service. The
`id` names each service, its image (`<prefix>-<id>`), and its entry in the workflow that
publishes the images to GitHub's container registry. A full-stack stack needs no deployment
facts for Docker: its app is the root Dockerfile's image, the `web` service on port 3000. For
Railway, it creates a public frontend service and a private API service, configures their health
checks and API migrations, and connects them over Railway's private network. The generated
`.railway/railway.ts` is the source of truth for those service settings. Without a web app, the
API is the public service on both: Caddy serves it, and Railway gives it the public domain.

## Adding a stack

1. Add `apps/<name>/` with the app, its `package.json` scripts, `.env.example`, `Dockerfile`
   (unless it is a shell or a mobile app), `clubedge.stack.json`, and its deployment service
   facts where applicable.
2. Implement the module options it supports, as files in its folder, and list them.
3. Run the Starter's `scripts/template-manifest.test.ts`, then generate a project with
   `--template-dir` and run its checks.

Nothing else changes: not the CLI, not the other stacks, not the module descriptors.

## Schema 5

Schema 5 is schema 4 with the `shell` role; nothing else changes. A Starter that offers a shell
declares schema 5, so a CLI that predates the role refuses it and asks to be updated instead of
failing on an unknown role. Schema 4 manifests are read as before, without the role.

## Schema 6

Schema 6 is schema 5 with the `mobile` role, the same way: a Starter that offers a mobile app
declares schema 6, a CLI that predates the role refuses it, and schema 4 and 5 manifests are read
as before, without it. Schema 6 also adds a stack's `auditIgnores`, which an older CLI would
leave in every project, a slot's `optional`, which an older CLI would ignore, bringing the
default back, a slot's `files`, `scripts`, and `fallback`, and the template's `rules`.

## Older Starters

Starters with schema 1 to 3 (one `clubedge.template.json` listing every file) are read into
the same model: each framework becomes a full-stack stack in the `framework` slot that
implements every option. Projects created from them still add, remove, and upgrade.
