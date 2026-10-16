import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { UsageError } from "../cli/args.js";

/*
 * Railway's free VM (https://railway.com/free-vm): `ssh railway.new` gives a temporary Linux box
 * with no account. Everything this CLI relies on about it is in this file, so a change on
 * Railway's side is a change here.
 */

export const railwayHost = "railway.new";
export const railwayTermsUrl = "https://railway.com/legal/terms";
export const railwayFreeVmUrl = "https://railway.com/free-vm";

/**
 * The host keys railway.new presents, as OpenSSH SHA256 fingerprints. Connecting to anything
 * else fails. CLUBEDGE_RAILWAY_HOST_KEY adds one (comma-separated), for when Railway rotates its
 * key before a CLI release catches up.
 */
const pinnedHostKeys = ["SHA256:+S1xg92FrnHz6pY3bpkmh1OGtWQGNANXilPzlxA7B1g"];

export function trustedHostKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.CLUBEDGE_RAILWAY_HOST_KEY ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...pinnedHostKeys, ...extra];
}

/** The OpenSSH fingerprint of a raw host key: "SHA256:" and unpadded base64, as ssh prints it. */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/** What Railway reports about the VM, on stderr, each time a command runs over SSH. */
export interface RailwayVm {
  status: string;
  state: string;
  previewUrl: string;
  claimUrl: string;
  /** When the build window ends; the VM can be claimed for 24 hours after. */
  expiresAt: Date;
}

/**
 * Finds Railway's JSON status line in a command's stderr. Returns null when there is none, and
 * throws when there is one without the fields this CLI needs.
 */
export function parseRailwayStatus(stderr: string): RailwayVm | null {
  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof value.status !== "string") continue;
    const previewUrl = value.preview_url;
    const claimUrl = value.human_claim_url;
    const expiresAt = new Date(String(value.build_expires_at));
    if (typeof previewUrl !== "string" || !/^https:\/\//.test(previewUrl) || typeof claimUrl !== "string" || Number.isNaN(expiresAt.getTime())) {
      throw new Error(
        `Railway answered, but not as this CLI expects (status "${value.status}"). Railway may have changed its free VM; update the CLI, or see ${railwayFreeVmUrl}.`,
      );
    }
    return { status: value.status, state: String(value.state ?? ""), previewUrl: previewUrl.replace(/\/+$/, ""), claimUrl, expiresAt };
  }
  return null;
}

/** Where the CLI keeps its own SSH key for Railway, apart from the user's ~/.ssh. */
export function railwayKeyPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const configHome =
    env.XDG_CONFIG_HOME || (platform === "win32" && env.APPDATA ? env.APPDATA : join(homedir(), ".config"));
  return join(configHome, "clubedge", "railway_ed25519");
}

/** What the CLI remembers about the last VM it set up, so `try --status` can answer without connecting. */
export interface LastVm {
  previewUrl: string;
  claimUrl: string;
  /** When the 60-minute build window ends (ISO). */
  expiresAt: string;
  /** The project's directory on the VM, such as /app/my-app. */
  directory: string;
}

/** Saved next to the CLI's key, in its config directory. */
export function lastVmPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  return join(dirname(railwayKeyPath(env, platform)), "railway-vm.json");
}

/** Railway keeps an unclaimed VM claimable for 24 hours after its build window. */
export const claimWindowMs = 24 * 60 * 60 * 1000;

/**
 * Where a VM stands: running (inside its 60 minutes), claimable (past them, still claimable), or
 * gone. Connecting to a VM that is gone would create a new one, so status never does.
 */
export function vmPhase(vm: LastVm, now = new Date()): { phase: "running" | "claimable" | "gone"; minutesLeft: number; claimUntil: Date } {
  const expires = new Date(vm.expiresAt).getTime();
  const claimUntil = new Date(expires + claimWindowMs);
  const minutesLeft = Math.max(0, Math.round((expires - now.getTime()) / 60_000));
  const phase = now.getTime() < expires ? "running" : now.getTime() < claimUntil.getTime() ? "claimable" : "gone";
  return { phase, minutesLeft, claimUntil };
}

/** A local port forward to the app on the VM: works from this machine whatever its IP, nothing shared. */
export function portForwardCommand(keyPath: string): string {
  return `ssh -i "${keyPath}" -N -L 3000:127.0.0.1:3000 ${railwayHost}`;
}

/**
 * The modules for a project on the VM. It has no Docker, so the database is PGlite (--infra
 * local) or a free Neon database (--infra neon), and sign-in is Better Auth; email is off, since
 * nothing there receives it. Flags the user passed win, unless the VM cannot run them.
 */
export function tryModules(requested: Record<string, string>): Record<string, string> {
  const infra = requested.infra ?? "local";
  if (infra !== "local" && infra !== "neon") {
    throw new UsageError(`try runs on a VM without Docker, so it needs --infra local or --infra neon (not --infra ${infra}).`);
  }
  const auth = requested.auth ?? "better-auth";
  if (auth === "supabase") {
    throw new UsageError("try cannot run Supabase Auth, which needs Docker or a Supabase project. Use --auth better-auth or --auth none.");
  }
  return { ...requested, infra, auth, email: requested.email ?? "none" };
}

/**
 * Why an existing project cannot run on the VM, or null when it can. The VM has no Docker, so the
 * database must be PGlite (infra local), hosted (neon), or none, and Supabase Auth is out.
 */
export function projectTryProblem(modules: Record<string, string>): string | null {
  const infra = modules.infra ?? "none";
  if (infra !== "local" && infra !== "neon" && infra !== "none") {
    return `This project runs its services with infra ${infra}, which needs Docker; the VM has none. Switch with \`pnpm clubedge add infra local\` (PGlite, no Docker), then run try again.`;
  }
  if (modules.auth === "supabase") {
    return "This project signs in with Supabase Auth, which needs Docker or a Supabase project; the VM has neither. Switch with `pnpm clubedge add auth better-auth`, then run try again.";
  }
  return null;
}

/** A project's package name as a directory name on the VM. */
export function remoteName(packageName: string): string {
  const name = packageName.replace(/^@[^/]+\//, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return name || "my-app";
}

/** A value as one single-quoted shell word. */
export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Where the project on the VM comes from: created there, or uploaded from this machine. */
export type TrySource =
  | { kind: "create"; cliVersion: string; framework?: string; ref?: string }
  | { kind: "upload"; name: string };

export interface TryScriptOptions {
  source: TrySource;
  modules: Record<string, string>;
  previewUrl: string;
  /** A hosted database (Neon) for the VM's env files: DATABASE_URL and DATABASE_URL_DIRECT. */
  database?: { url: string; directUrl: string };
}

/** The create command's flags on the VM: the chosen selection, without prompts. */
export function tryCreateArgs({ framework, modules, ref }: { framework?: string; modules: Record<string, string>; ref?: string }): string[] {
  return [
    ...(framework ? ["--framework", framework] : []),
    ...Object.entries(modules).flatMap(([module, option]) => [`--${module}`, option]),
    ...(ref ? ["--ref", ref] : []),
    // try creates the Neon database here and writes its URLs on the VM.
    ...(modules.infra === "neon" ? ["--no-neon"] : []),
    "--yes",
  ];
}

export const remoteDir = "/app";
export const remoteLog = `${remoteDir}/clubedge-try.log`;
export const remoteDevLog = `${remoteDir}/clubedge-dev.log`;
export const remoteScriptPath = `${remoteDir}/clubedge-try.sh`;
export const remoteProxyPath = `${remoteDir}/clubedge-proxy.mjs`;
export const remoteArchivePath = `${remoteDir}/clubedge-upload.tgz`;

/**
 * The script the VM runs. It reports progress on stdout as "@@step <text>", then "@@ready <dir>",
 * or "@@fail <text>" followed by the end of the log as "@@log <line>". The servers it starts keep
 * running after the SSH session ends.
 */
export function tryScript({ source, modules, previewUrl, database }: TryScriptOptions): string {
  const base = source.kind === "create" ? "my-app" : source.name;
  const prepare =
    source.kind === "create"
      ? `step "Creating the project in ${remoteDir}/$dir"
${["pnpm", "dlx", `@clubedge/create-clubedge-app@${source.cliVersion}`, '"$dir"', ...tryCreateArgs({ ...source, modules }).map(shellQuote)].join(" ")} >>"$log" 2>&1 || fail "The project could not be created"
cd "$dir" || fail "The project directory is missing"`
      : `step "Unpacking the project in ${remoteDir}/$dir"
mkdir -p "$dir" && tar xzf ${remoteArchivePath} -C "$dir" >>"$log" 2>&1 || fail "The upload could not be unpacked"
rm -f ${remoteArchivePath}
cd "$dir" || fail "The project directory is missing"
step "Installing dependencies"
pnpm install >>"$log" 2>&1 || fail "pnpm install failed"`;
  const betterAuth = modules.auth === "better-auth";
  const localDb = modules.infra === "local";
  // Node writes the values, so a password's characters need no escaping for sed.
  const setDatabase = database
    ? `node -e ${shellQuote(
        'const fs=require("node:fs");const v=JSON.parse(process.argv[1]);for(const f of process.argv.slice(2)){let t=fs.readFileSync(f,"utf8");for(const[k,x]of Object.entries(v)){const r=new RegExp("^"+k+"=.*$","m");t=r.test(t)?t.replace(r,()=>k+"="+x):t.replace(/\\n?$/,"\\n")+k+"="+x+"\\n"}fs.writeFileSync(f,t)}',
      )} ${shellQuote(JSON.stringify({ DATABASE_URL: database.url, DATABASE_URL_DIRECT: database.directUrl }))} apps/*/.env.local`
    : "";
  return `#!/usr/bin/env bash
# Written by create-clubedge-app try. Logs: ${remoteLog}, ${remoteDevLog}
set -uo pipefail
cd ${remoteDir}
log=${remoteLog}
: > "$log"
step() { echo "@@step $*"; echo "== $*" >> "$log"; }
fail() { echo "@@fail $*"; tail -n 40 "$log" | sed 's/^/@@log /'; exit 1; }
port="\${PORT:-8080}"

step "Preparing pnpm"
command -v pnpm >/dev/null 2>&1 || corepack enable pnpm >>"$log" 2>&1 || npm install -g pnpm@10 >>"$log" 2>&1 || fail "pnpm could not be installed"

# A second run on the same VM replaces the servers of the first, and uses a new directory.
pkill -f clubedge-proxy.mjs >/dev/null 2>&1
pkill -f "next dev|vite dev|local-db" >/dev/null 2>&1

step "Starting the preview proxy"
setsid nohup node ${remoteProxyPath} "$port" 3000 ${shellQuote(previewUrl)} >>${remoteDir}/clubedge-proxy.log 2>&1 < /dev/null &

base=${shellQuote(base)}
dir="$base"
n=2
while [ -e "$dir" ]; do dir="$base-$n"; n=$((n + 1)); done
${prepare}

# The local env file from the example, as create does (the Starter's env.example and env.target);
# an uploaded project has none, since env files never leave the user's machine.
if [ -f .env.example ] && [ -d apps/web ] && [ ! -f apps/web/.env.local ]; then cp .env.example apps/web/.env.local; fi
for example in apps/*/.env.example; do
  [ -f "$example" ] || continue
  target="\${example%.example}.local"
  [ -f "$target" ] || cp "$example" "$target"
done
${
  betterAuth
    ? `
secret=$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')
for envfile in apps/*/.env.local; do
  [ -f "$envfile" ] || continue
  if grep -q '^BETTER_AUTH_SECRET=' "$envfile"; then
    sed -i "s/^BETTER_AUTH_SECRET=.*/BETTER_AUTH_SECRET=$secret/" "$envfile"
  else
    echo "BETTER_AUTH_SECRET=$secret" >> "$envfile"
  fi
done
`
    : ""
}${
  database
    ? `
step "Using the Neon database"
${setDatabase} >>"$log" 2>&1 || fail "The database URLs could not be written"

step "Migrating the database"
pnpm run --if-present db:migrate >>"$log" 2>&1 || fail "The database migration failed"
`
    : ""
}${
  localDb
    ? `
step "Starting the local database"
db=${remoteDir}/clubedge-db.log
: > "$db"
setsid nohup pnpm infra:up >>"$db" 2>&1 < /dev/null &
for _ in $(seq 120); do grep -q "Local database ready" "$db" && break; sleep 1; done
grep -q "Local database ready" "$db" || { cat "$db" >> "$log"; fail "The local database did not start"; }

step "Migrating the database"
pnpm run --if-present db:migrate >>"$log" 2>&1 || fail "The database migration failed"
`
    : ""
}
step "Starting the app"
: > ${remoteDevLog}
setsid nohup pnpm dev >>${remoteDevLog} 2>&1 < /dev/null &
code=000
for _ in $(seq 300); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ || true)
  [ "$code" != "000" ] && break
  sleep 1
done
[ "$code" != "000" ] || { tail -n 40 ${remoteDevLog} >> "$log"; fail "The app did not start"; }
echo "@@ready $dir"
`;
}

/**
 * A small reverse proxy for the VM: Railway's preview URL reaches it on $PORT, and it forwards to
 * the dev server on localhost. The Starter's dev servers only serve their scripts to localhost
 * (Next.js allowedDevOrigins, Vite's host check), and Next.js compares Origin with the forwarded
 * host for form posts, so requests are made to look local, and redirects to localhost are pointed
 * back at the preview URL. Until the app answers, it shows a page that reloads itself.
 */
export const proxySource = `import http from "node:http";
import net from "node:net";

const [port = "8080", upstreamPort = "3000", publicOrigin = ""] = process.argv.slice(2);
const local = "http://localhost:" + upstreamPort;

function toLocal(headers) {
  const result = { ...headers, host: "localhost:" + upstreamPort };
  delete result["x-forwarded-host"];
  delete result.forwarded;
  if (result.origin) result.origin = local;
  if (result.referer && publicOrigin) result.referer = result.referer.replace(publicOrigin, local);
  return result;
}

const starting = '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Starting</title>' +
  '<body style="font:16px system-ui;display:grid;place-items:center;height:90vh;color:#444">' +
  "<p>Your Clubedge app is starting. This page reloads by itself.</p>";

const server = http.createServer((req, res) => {
  const upstream = http.request(
    { host: "127.0.0.1", port: Number(upstreamPort), method: req.method, path: req.url, headers: toLocal(req.headers) },
    (answer) => {
      const headers = { ...answer.headers };
      if (headers.location && publicOrigin) headers.location = headers.location.replace(local, publicOrigin);
      res.writeHead(answer.statusCode ?? 502, headers);
      answer.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(503, { "content-type": "text/html; charset=utf-8", "retry-after": "5" });
    res.end(starting);
  });
  req.pipe(upstream);
});

// Hot reload: pass WebSocket upgrades through with the same local headers.
server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(Number(upstreamPort), "127.0.0.1", () => {
    const lines = [req.method + " " + req.url + " HTTP/1.1"];
    for (const [name, value] of Object.entries(toLocal(req.headers))) {
      for (const item of [].concat(value)) lines.push(name + ": " + item);
    }
    upstream.write(lines.join("\\r\\n") + "\\r\\n\\r\\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(Number(port), "0.0.0.0");
`;
