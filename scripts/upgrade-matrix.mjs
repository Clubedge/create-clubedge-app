#!/usr/bin/env node
// The upgrade matrix: projects generated from older Starter releases, changed the way developers
// change them, then upgraded to the Starter the CLI pins, with what happened recorded as JSON.
// The upgrade-matrix workflow runs it; starter.clubedge.live builds its Upgrades page from the
// JSON it publishes.
//
//   node scripts/upgrade-matrix.mjs plan --repo <owner/name> --target <vX.Y.Z>
//     The starting releases: the oldest release of each template schema, and the release before
//     the target, as JSON for a workflow matrix.
//   node scripts/upgrade-matrix.mjs run --cli "<command>" --start <vX.Y.Z> --schema <n> --stack <next|vite-hono> --out <file> [--work <dir>]
//     Generates a project from the start release and runs every scenario on a copy of it.
//   node scripts/upgrade-matrix.mjs merge --plan <plan.json> --out <file> [--releases <github releases JSON>] [--run-url <url>] [--cli-version <version>] <result.json>...
//   node scripts/upgrade-matrix.mjs summary <matrix.json>
//     Markdown for the job summary; exits 1 when a result is a failure, not a finding.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

const [command, ...rest] = process.argv.slice(2);
const options = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) options[rest[i].slice(2)] = rest[++i];
  else positional.push(rest[i]);
}

const SCHEMA = 1;
const MARKER = /^<<<<<<< yours/m;
const IDENTITY = ["-c", "user.name=Upgrade matrix", "-c", "user.email=upgrade-matrix@example.com", "-c", "commit.gpgsign=false"];
// Files that differ between any two generated projects, or that the tools write.
const UNCOMPARED = [/^\.git\//, /(^|\/)node_modules\//, /^\.clubedge\//, /(^|\/)\.env(\.[^/]*)?\.local$/, /(^|\/)\.env$/, /(^|\/)(\.next|\.turbo|\.output|\.vinxi|\.tanstack|dist)\//];
const env = { ...process.env, CI: "1", NEXT_TELEMETRY_DISABLED: "1", TURBO_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" };

function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.replace(/^v/, "").split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

const strip = (text) => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "\n");

/** Runs a command, keeps its output in the log directory, and returns its exit code and output. */
function exec(file, args, { cwd, timeout = 900, log }) {
  const started = Date.now();
  const res = spawnSync(file, args, { cwd, env, encoding: "utf8", timeout: timeout * 1000, maxBuffer: 64 * 1024 * 1024 });
  const output = strip(`${res.stdout ?? ""}${res.stderr ?? ""}`);
  const code = res.error?.code === "ETIMEDOUT" ? "timeout" : (res.status ?? 1);
  if (log) writeFileSync(log, `$ ${file} ${args.join(" ")}\n# exit ${code} in ${Math.round((Date.now() - started) / 1000)} s\n\n${output}`);
  return { code, output, seconds: Math.round((Date.now() - started) / 1000) };
}

/** The lines worth showing for a failure: errors first, else the last lines, without spinner frames. */
function excerpt(output) {
  const lines = output
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[│|◆◇▲●■•oO0T—-]\s+)*/, "").trimEnd())
    .filter((line) => line.length > 2 && !/Preparing Starter|^[│|]$/.test(line));
  const errors = lines.filter((line) => /\berror\b|ERR_|FAIL|✗|×/i.test(line));
  return (errors.length ? errors.slice(0, 4) : lines.slice(-3)).map((line) => line.slice(0, 300));
}

const step = (r) => ({ ok: r.code === 0, exit: r.code, seconds: r.seconds, ...(r.code === 0 ? {} : { excerpt: excerpt(r.output) }) });

function git(cwd, args, log) {
  return exec("git", [...IDENTITY, ...args], { cwd, timeout: 300, log });
}

/** Every file the project keeps: tracked or not ignored. */
function projectFiles(dir) {
  if (!existsSync(join(dir, ".git"))) exec("git", ["init", "-q"], { cwd: dir });
  return exec("git", ["ls-files", "-co", "--exclude-standard"], { cwd: dir })
    .output.split("\n")
    .filter((file) => file && !UNCOMPARED.some((pattern) => pattern.test(file)) && existsSync(join(dir, file)));
}

function conflicts(dir) {
  const files = [];
  let blocks = 0;
  for (const file of projectFiles(dir)) {
    const path = join(dir, file);
    if (!existsSync(path) || statSync(path).size > 2_000_000) continue;
    const text = readFileSync(path, "utf8");
    if (!MARKER.test(text)) continue;
    const count = text.split("\n").filter((line) => line.startsWith("<<<<<<< yours")).length;
    files.push({ file, blocks: count });
    blocks += count;
  }
  return { files, blocks };
}

/** The project's choices as CLI flags, from the provenance it records in package.json. */
function provenanceFlags(dir) {
  const c = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).clubedge ?? {};
  const flags = [];
  if (c.framework) flags.push("--framework", c.framework);
  for (const [slot, option] of Object.entries(c.apps ?? {})) flags.push(`--${slot}`, option);
  for (const [module, option] of Object.entries(c.modules ?? {})) flags.push(`--${module}`, option);
  return flags;
}

const provenance = (dir) => {
  const c = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).clubedge ?? {};
  return { starterRef: c.starterRef, starterCommit: c.starterCommit, framework: c.framework ?? null, apps: c.apps ?? {}, modules: c.modules ?? {} };
};

const appDir = (dir) => ["apps/web", "apps/start", "apps/vite"].find((app) => existsSync(join(dir, app, "package.json")));

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

// --- plan -----------------------------------------------------------------------------------

async function schemaOf(repo, tag) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`https://raw.githubusercontent.com/${repo}/${tag}/clubedge.template.json`);
    if (response.status === 404) return 0;
    if (response.ok) return (await response.json()).schemaVersion ?? 0;
    if (attempt === 3) throw new Error(`Could not read clubedge.template.json at ${tag}: HTTP ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
}

async function plan({ repo, target }) {
  if (!repo || !target) throw new Error("plan needs --repo and --target");
  const refs = exec("git", ["ls-remote", "--tags", "--refs", `https://github.com/${repo}.git`, "refs/tags/v*"], { timeout: 120 }).output;
  const tags = refs
    .split("\n")
    .map((line) => line.split("refs/tags/")[1])
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag ?? "") && compareVersions(tag, target) <= 0)
    .sort(compareVersions);
  if (!tags.includes(target)) throw new Error(`${repo} has no tag ${target}`);
  const releases = [];
  for (let i = 0; i < tags.length; i += 8) {
    const batch = tags.slice(i, i + 8);
    const schemas = await Promise.all(batch.map((tag) => schemaOf(repo, tag)));
    batch.forEach((ref, j) => releases.push({ ref, schema: schemas[j] }));
  }
  const schemaOfRef = new Map(releases.map((r) => [r.ref, r.schema]));
  const oldest = new Map();
  for (const { ref, schema } of releases) if (ref !== target && !oldest.has(schema)) oldest.set(schema, ref);
  const previous = tags.filter((tag) => tag !== target).at(-1);
  const starts = [];
  const add = (ref, stack) => {
    if (ref && !starts.some((s) => s.ref === ref && s.stack === stack)) starts.push({ ref, schema: schemaOfRef.get(ref), stack, id: `${ref}-${stack}` });
  };
  for (const ref of [...oldest.values(), previous].sort(compareVersions)) add(ref, "next");
  // A second stack where the Starter has one: React + Vite with a Hono API, from v0.22.0.
  for (const ref of [oldest.get(schemaOfRef.get(target)), previous]) if (ref && compareVersions(ref, "v0.22.0") >= 0) add(ref, "vite-hono");
  return { repo, target, targetSchema: schemaOfRef.get(target), starts, releases };
}

// --- run ------------------------------------------------------------------------------------

function stackFlags(schema, stack) {
  if (stack === "vite-hono") return ["--framework", "vite", "--api", "hono"];
  // The first releases offered one framework, Next.js, and took no flag for it.
  return schema >= 2 ? ["--framework", "next"] : [];
}

/** A dependency of the app that the target Starter asks a different version of, to patch. */
function dependencyToPatch(project, target) {
  const app = appDir(project);
  if (!app || !existsSync(join(target, app, "package.json"))) return null;
  const now = readJson(join(project, app, "package.json")).dependencies ?? {};
  const next = readJson(join(target, app, "package.json")).dependencies ?? {};
  const changed = Object.keys(now).filter((name) => next[name] && next[name] !== now[name] && !now[name].startsWith("workspace:"));
  const preferred = ["zod", "lucide-react", "clsx", "tailwind-merge", "@tanstack/react-query", "react-hook-form", "react"];
  const name = preferred.find((dep) => changed.includes(dep)) ?? changed[0];
  return name ? { app, name, from: now[name], to: next[name] } : null;
}

function patchDependency(dir, dep, logs) {
  const installed = join(dir, dep.app, "node_modules", dep.name, "package.json");
  if (!existsSync(installed)) return { ok: false, reason: `${dep.name} is not installed in ${dep.app}` };
  const version = readJson(installed).version;
  const edit = join(tmpdir(), `matrix-patch-${process.pid}-${Date.now()}`);
  const opened = exec("pnpm", ["patch", `${dep.name}@${version}`, "--edit-dir", edit], { cwd: dir, timeout: 300, log: join(logs, "patch.log") });
  if (opened.code !== 0) return { ok: false, reason: excerpt(opened.output).join(" ") };
  const main = readJson(join(edit, "package.json")).main ?? "index.js";
  const file = existsSync(join(edit, main)) ? main : "package.json";
  if (file === "package.json") writeFileSync(join(edit, "PATCHED.md"), "Patched by Acme for a local fix.\n");
  else writeFileSync(join(edit, file), `${readFileSync(join(edit, file), "utf8")}\n// Patched by Acme for a local fix.\n`);
  const committed = exec("pnpm", ["patch-commit", edit], { cwd: dir, timeout: 600, log: join(logs, "patch-commit.log") });
  rmSync(edit, { recursive: true, force: true });
  return committed.code === 0 ? { ok: true, package: dep.name, version, startRange: dep.from, targetRange: dep.to } : { ok: false, reason: excerpt(committed.output).join(" ") };
}

/** What a developer typically changes: a dependency, scripts, an override, the README, the home page. */
function featureEdits(dir, logs) {
  const app = appDir(dir);
  const done = [];
  if (app) {
    const added = exec("pnpm", ["add", "zod-to-json-schema"], { cwd: join(dir, app), timeout: 600, log: join(logs, "feature-add.log") });
    if (added.code === 0) done.push(`added zod-to-json-schema to ${app}`);
    const pkg = readJson(join(dir, app, "package.json"));
    pkg.scripts = { ...pkg.scripts, clean: "rm -rf dist .next .turbo" };
    writeJson(join(dir, app, "package.json"), pkg);
    done.push(`a clean script in ${app}`);
  }
  const root = readJson(join(dir, "package.json"));
  root.scripts = { ...root.scripts, "dev:all": "turbo run dev" };
  root.pnpm = { ...root.pnpm, overrides: { ...root.pnpm?.overrides, "cookie@<0.7.0": ">=0.7.0" } };
  writeJson(join(dir, "package.json"), root);
  done.push("a root script and a pnpm override");
  const readme = readFileSync(join(dir, "README.md"), "utf8");
  const intro = "# Acme Portal\n\nThe member portal for Acme, built on Clubedge Starter.\n";
  writeFileSync(join(dir, "README.md"), /^# .+$/m.test(readme) ? readme.replace(/^# .+\n/m, intro) : `${intro}\n${readme}`);
  done.push("the README's title and introduction");
  if (app) {
    mkdirSync(join(dir, app, "src/lib"), { recursive: true });
    writeFileSync(join(dir, app, "src/lib/acme.ts"), 'export const acmeName = "Acme Portal";\n');
    done.push(`a new file, ${app}/src/lib/acme.ts`);
    const home = ["src/app/page.tsx", "src/routes/index.tsx", "app/routes/index.tsx", "app/page.tsx"].map((p) => join(app, p)).find((p) => existsSync(join(dir, p)));
    if (home) {
      writeFileSync(join(dir, home), `// Acme: the member portal's home page.\n${readFileSync(join(dir, home), "utf8")}`);
      done.push(`a comment on the home page, ${home}`);
    }
  }
  const installed = exec("pnpm", ["install", "--no-frozen-lockfile"], { cwd: dir, timeout: 900, log: join(logs, "feature-install.log") });
  return { ok: installed.code === 0, edits: done };
}

/** Compares an upgraded project with one generated from the target with the same choices. */
function compareWithFresh(cli, project, work, logs) {
  const parent = join(work, "fresh");
  rmSync(parent, { recursive: true, force: true });
  mkdirSync(parent, { recursive: true });
  const flags = provenanceFlags(project);
  const made = exec(cli[0], [...cli.slice(1), "my-app", ...flags, "--yes", "--no-install", "--no-git"], { cwd: parent, timeout: 600, log: join(logs, "fresh.log") });
  if (made.code !== 0) return { ok: false, flags: flags.join(" "), excerpt: excerpt(made.output) };
  const fresh = join(parent, "my-app");
  const a = new Set(projectFiles(project));
  const b = new Set(projectFiles(fresh));
  const differing = [];
  for (const file of new Set([...a, ...b])) {
    if (!a.has(file) || !b.has(file)) differing.push(`${file} (${a.has(file) ? "only in the upgraded project" : "only in a fresh project"})`);
    else if (!readFileSync(join(project, file)).equals(readFileSync(join(fresh, file)))) differing.push(file);
  }
  rmSync(parent, { recursive: true, force: true });
  return { ok: true, identical: differing.length === 0, flags: flags.join(" "), differing: differing.sort().slice(0, 40), differingCount: differing.length };
}

function upgradeFindings(output) {
  const updated = /Updated (\d+) files?/.exec(output);
  const notes = output
    .split("\n")
    .map((line) => line.replace(/^[\s│◆◇▲●■|>-]+/, "").trim())
    .filter((line) => /had no modules yet|ERR_PNPM_UNUSED_PATCH|Skipped `pnpm install`/.test(line))
    .slice(0, 6)
    .map((line) => line.slice(0, 400));
  return { updatedFiles: updated ? Number(updated[1]) : 0, notes, namedUnusedPatch: /ERR_PNPM_UNUSED_PATCH/.test(output) };
}

/** Keys each exact-version patch by its package alone, as the CLI advises when the upgrade leaves it unused. */
function keyPatchesByName(dir) {
  const path = join(dir, "package.json");
  const pkg = readJson(path);
  const patches = pkg.pnpm?.patchedDependencies;
  if (patches) {
    for (const key of Object.keys(patches)) {
      const at = key.lastIndexOf("@");
      if (at > 0) {
        patches[key.slice(0, at)] = patches[key];
        delete patches[key];
      }
    }
    writeJson(path, pkg);
  }
  const workspace = join(dir, "pnpm-workspace.yaml");
  if (existsSync(workspace)) {
    const text = readFileSync(workspace, "utf8").replace(/^(\s+['"]?)((?:@[^/\s'"]+\/)?[^@\s'"]+)@[^:'"\s]+(['"]?\s*:)/gm, "$1$2$3");
    writeFileSync(workspace, text);
  }
}

function runScenario({ id, title, cli, base, work, logsRoot, change, afterUpgrade }) {
  const dir = join(work, id);
  const logs = join(logsRoot, id);
  mkdirSync(logs, { recursive: true });
  rmSync(dir, { recursive: true, force: true });
  exec("git", ["clone", "-q", base, dir], { timeout: 120 });
  const result = { id, title };
  result.startInstall = step(exec("pnpm", ["install", "--frozen-lockfile"], { cwd: dir, timeout: 900, log: join(logs, "install-start.log") }));
  try {
    result.change = change(dir, logs);
  } catch (error) {
    result.change = { ok: false, reason: String(error).slice(0, 300) };
  }
  if (result.change.skip) {
    // Nothing to try here, such as no dependency the target changes to patch.
    result.skipped = result.change.skip;
    rmSync(dir, { recursive: true, force: true });
    return result;
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", `Developer change: ${title}`]);
  const up = exec(cli[0], [...cli.slice(1), "upgrade", "--no-install", "--yes", "--detailed-exit-code"], { cwd: dir, timeout: 900, log: join(logs, "upgrade.log") });
  const found = conflicts(dir);
  result.upgrade = { exit: up.code, seconds: up.seconds, ...upgradeFindings(up.output), conflicts: found };
  if (up.code !== 0 && up.code !== 2) result.upgrade.excerpt = excerpt(up.output);
  result.after = provenance(dir);
  if (afterUpgrade) Object.assign(result, afterUpgrade(dir, logs, up));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "Upgrade"]);
  if (up.code === 0 && found.files.length === 0) {
    const install = exec("pnpm", ["install", "--no-frozen-lockfile"], { cwd: dir, timeout: 900, log: join(logs, "install.log") });
    result.install = step(install);
    result.install.unusedPatch = /ERR_PNPM_UNUSED_PATCH/.test(install.output);
    if (result.install.unusedPatch) {
      // The CLI's advice: key the patch by the package alone, so it applies to whichever version pnpm installs.
      keyPatchesByName(dir);
      result.installAfterAdvice = step(exec("pnpm", ["install", "--no-frozen-lockfile"], { cwd: dir, timeout: 900, log: join(logs, "install-after-advice.log") }));
    }
    if (result.install.ok || result.installAfterAdvice?.ok) {
      result.typecheck = step(exec("pnpm", ["typecheck"], { cwd: dir, timeout: 1200, log: join(logs, "typecheck.log") }));
      result.test = step(exec("pnpm", ["test"], { cwd: dir, timeout: 1200, log: join(logs, "test.log") }));
    }
  }
  rmSync(dir, { recursive: true, force: true });
  return result;
}

function roundTrips({ cli, base, work, logsRoot, start, stack, modules }) {
  const pairs = [];
  if (modules.cache) pairs.push([["add", "cache", modules.cache === "memory" ? "redis" : "memory"], ["add", "cache", modules.cache]]);
  if (modules.auth) pairs.push([["add", "auth", modules.auth === "better-auth" ? "supabase" : "better-auth"], ["add", "auth", modules.auth]]);
  if (modules.storage && modules.storage !== "none") pairs.push([["remove", "storage"], ["add", "storage", modules.storage]]);
  // The apps need a frontend of static files and an API of its own: Next.js has neither.
  if (stack === "vite-hono" && compareVersions(start, "v0.27.0") >= 0) pairs.push([["add", "shell", "capacitor"], ["remove", "shell"]]);
  if (stack === "vite-hono" && compareVersions(start, "v0.28.0") >= 0) pairs.push([["add", "mobile", "expo"], ["remove", "mobile"]]);
  const logs = join(logsRoot, "round-trips");
  mkdirSync(logs, { recursive: true });
  return pairs.map(([forward, back], i) => {
    const dir = join(work, `round-trip-${i}`);
    rmSync(dir, { recursive: true, force: true });
    exec("git", ["clone", "-q", base, dir], { timeout: 120 });
    const startCommit = exec("git", ["rev-parse", "HEAD"], { cwd: dir }).output.trim();
    const there = exec(cli[0], [...cli.slice(1), ...forward, "--no-install", "--yes", "--detailed-exit-code"], { cwd: dir, timeout: 600, log: join(logs, `${i}-forward.log`) });
    const trip = { change: forward.join(" "), back: back.join(" "), exit: there.code, conflicts: conflicts(dir).files.length };
    if (there.code === 0) {
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", forward.join(" ")]);
      const again = exec(cli[0], [...cli.slice(1), ...back, "--no-install", "--yes", "--detailed-exit-code"], { cwd: dir, timeout: 600, log: join(logs, `${i}-back.log`) });
      git(dir, ["add", "-A"]);
      const differing = exec("git", ["diff", "--cached", "--name-only", startCommit], { cwd: dir }).output.split("\n").filter(Boolean);
      Object.assign(trip, { backExit: again.code, identical: again.code === 0 && differing.length === 0, differing: differing.slice(0, 20) });
    } else {
      trip.excerpt = excerpt(there.output);
    }
    rmSync(dir, { recursive: true, force: true });
    return trip;
  });
}

function run({ cli: cliCommand, start, schema, stack, out, work: workOption }) {
  if (!cliCommand || !start || !stack || !out) throw new Error("run needs --cli, --start, --stack, and --out");
  const cli = cliCommand.split(/\s+/).filter(Boolean);
  const startSchema = Number(schema ?? 6);
  const work = workOption ?? join(tmpdir(), `upgrade-matrix-${start}-${stack}`);
  const logsRoot = join(work, "logs");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(logsRoot, { recursive: true });
  const started = Date.now();
  const result = { schemaVersion: SCHEMA, start, startSchema, stack, flags: stackFlags(startSchema, stack).join(" ") };

  const made = exec(cli[0], [...cli.slice(1), "my-app", "--ref", start, ...stackFlags(startSchema, stack), "--yes", "--no-install", "--no-git"], { cwd: work, timeout: 600, log: join(logsRoot, "generate.log") });
  const base = join(work, "my-app");
  result.generate = step(made);
  if (made.code !== 0 || !existsSync(join(base, "package.json"))) {
    result.generate.ok = false;
    writeJson(out, result);
    return;
  }
  exec("git", ["init", "-q"], { cwd: base });
  git(base, ["add", "-A"]);
  git(base, ["commit", "-qm", `Generated from ${start}`]);
  result.generated = provenance(base);

  let targetDir = null;
  const scenarios = [];
  // No edits: the upgrade must give exactly what the target Starter generates.
  scenarios.push(
    runScenario({
      id: "none", title: "No edits", cli, base, work, logsRoot,
      change: () => ({ ok: true, edits: [] }),
      afterUpgrade: (dir, logs, up) => {
        // Keep the upgraded app's manifest: the patch scenario patches a dependency it changes.
        const app = appDir(dir);
        if (app) {
          targetDir = join(work, "target");
          mkdirSync(join(targetDir, app), { recursive: true });
          writeFileSync(join(targetDir, app, "package.json"), readFileSync(join(dir, app, "package.json")));
        }
        return up.code === 0 ? { fresh: compareWithFresh(cli, dir, work, logs) } : {};
      },
    }),
  );
  scenarios.push(
    runScenario({
      id: "pnpm-up", title: "pnpm up -r", cli, base, work, logsRoot,
      change: (dir, logs) => {
        const up = exec("pnpm", ["up", "-r"], { cwd: dir, timeout: 900, log: join(logs, "pnpm-up.log") });
        return { ok: up.code === 0, edits: ["pnpm up -r: every dependency raised within its range"] };
      },
    }),
  );
  scenarios.push(
    runScenario({
      id: "patch", title: "A pnpm patch", cli, base, work, logsRoot,
      change: (dir, logs) => {
        const dep = targetDir ? dependencyToPatch(dir, targetDir) : null;
        if (!dep) return { ok: true, skip: "the target Starter changes none of the app's dependencies" };
        const patched = patchDependency(dir, dep, logs);
        return patched.ok ? { ok: true, edits: [`pnpm patch ${patched.package}@${patched.version}`], patch: patched } : patched;
      },
    }),
  );
  scenarios.push(runScenario({ id: "feature", title: "Feature edits", cli, base, work, logsRoot, change: featureEdits }));
  result.scenarios = scenarios;
  result.target = scenarios[0].after?.starterRef ?? null;
  result.roundTrips = Object.keys(result.generated.modules).length
    ? roundTrips({ cli, base, work, logsRoot, start, stack, modules: result.generated.modules })
    : [];
  result.seconds = Math.round((Date.now() - started) / 1000);
  rmSync(base, { recursive: true, force: true });
  writeJson(out, result);
}

// --- merge and summary ----------------------------------------------------------------------

function headline(body) {
  return /^##\s+(.+)$/m.exec(body ?? "")?.[1]?.trim() ?? null;
}

function merge({ plan: planFile, out, releases: releasesFile, "run-url": runUrl, "cli-version": cli }) {
  if (!planFile || !out) throw new Error("merge needs --plan and --out");
  const planned = readJson(planFile);
  const github = releasesFile && existsSync(releasesFile) ? readJson(releasesFile) : [];
  const byTag = new Map(github.map((release) => [release.tag_name, release]));
  const results = positional.map(readJson);
  const matrix = {
    schemaVersion: SCHEMA,
    generatedAt: new Date().toISOString(),
    run: runUrl ?? null,
    cli: cli ?? null,
    starter: { repository: planned.repo, target: planned.target, targetSchema: planned.targetSchema },
    command: "pnpm dlx @clubedge/create-clubedge-app@latest upgrade",
    starts: planned.starts.map((s) => results.find((r) => r.start === s.ref && r.stack === s.stack) ?? { start: s.ref, startSchema: s.schema, stack: s.stack, missing: true }),
    releases: planned.releases.map(({ ref, schema }) => {
      const release = byTag.get(ref);
      return {
        ref,
        schema,
        url: `https://github.com/${planned.repo}/releases/tag/${ref}`,
        publishedAt: release?.published_at ?? null,
        headline: headline(release?.body) ?? release?.name ?? null,
      };
    }),
  };
  writeJson(out, matrix);
}

/** Failures stop the workflow; findings, such as conflicts in files a developer changed, don't. */
function failures(start) {
  if (start.missing) return [`${start.start} ${start.stack}: no result`];
  if (!start.generate?.ok) return [`${start.start} ${start.stack}: generating the project failed`];
  const found = [];
  const name = `${start.start} ${start.stack}`;
  for (const s of start.scenarios ?? []) {
    if (s.skipped) continue;
    if (s.upgrade.exit !== 0 && s.upgrade.exit !== 2) found.push(`${name}, ${s.title}: the upgrade exited with ${s.upgrade.exit}`);
    if (s.install?.unusedPatch && !s.upgrade.namedUnusedPatch) found.push(`${name}, ${s.title}: pnpm install stopped at a patch the CLI did not name`);
    if (s.installAfterAdvice && !s.installAfterAdvice.ok) found.push(`${name}, ${s.title}: pnpm install still stopped after the CLI's advice`);
    if (s.id === "none") {
      if (s.upgrade.conflicts.files.length) found.push(`${name}, no edits: the upgrade left conflicts`);
      if (s.fresh && !s.fresh.identical) found.push(`${name}, no edits: ${s.fresh.differingCount} files differ from a fresh project`);
      if (s.install && !s.install.ok) found.push(`${name}, no edits: pnpm install failed`);
      if (s.typecheck && !s.typecheck.ok) found.push(`${name}, no edits: typecheck failed`);
      if (s.test && !s.test.ok) found.push(`${name}, no edits: tests failed`);
    }
  }
  for (const t of start.roundTrips ?? []) {
    if (t.exit !== 0) found.push(`${name}: ${t.change} exited with ${t.exit}`);
    else if (!t.identical) found.push(`${name}: ${t.change}, then ${t.back}, does not give the project back`);
  }
  return found;
}

const mark = (check) => (!check ? "–" : check.ok ? "✓" : "✗");

function summary(file) {
  const matrix = readJson(file);
  const lines = [
    `## Upgrade matrix: to Starter ${matrix.starter.target}`,
    "",
    "| From | Stack | Scenario | Upgrade | Conflicts | Install | Typecheck | Tests |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const all = [];
  for (const start of matrix.starts) {
    all.push(...failures(start));
    for (const s of start.scenarios ?? []) {
      if (s.skipped) {
        lines.push(`| ${start.start} | ${start.stack} | ${s.title} | skipped: ${s.skipped} | | | | |`);
        continue;
      }
      const c = s.upgrade.conflicts;
      const install = s.install?.unusedPatch ? `✗ unused patch${s.installAfterAdvice ? `, ${mark(s.installAfterAdvice)} after the advice` : ""}` : mark(s.install);
      lines.push(`| ${start.start} | ${start.stack} | ${s.title} | exit ${s.upgrade.exit} | ${c.files.length ? `${c.blocks} in ${c.files.map((f) => f.file).join(", ")}` : "none"} | ${install} | ${mark(s.typecheck)} | ${mark(s.test)} |`);
    }
    if (!start.scenarios) lines.push(`| ${start.start} | ${start.stack} | – | ${start.missing ? "no result" : "generating failed"} | | | | |`);
  }
  lines.push("", "### Round trips", "");
  for (const start of matrix.starts) {
    for (const t of start.roundTrips ?? []) lines.push(`- ${start.start} ${start.stack}: \`${t.change}\`, then \`${t.back}\`: ${t.identical ? "the same project" : `differs (${t.exit !== 0 ? `exit ${t.exit}` : (t.differing ?? []).join(", ")})`}`);
  }
  lines.push("", all.length ? `### Failures\n\n${all.map((f) => `- ${f}`).join("\n")}` : "No failures.");
  console.log(lines.join("\n"));
  if (all.length) process.exitCode = 1;
}

if (command === "plan") console.log(JSON.stringify(await plan(options), null, 2));
else if (command === "run") run(options);
else if (command === "merge") merge(options);
else if (command === "summary") summary(positional[0]);
else {
  console.error("Usage: upgrade-matrix.mjs plan|run|merge|summary (see the comment at the top)");
  process.exit(1);
}
