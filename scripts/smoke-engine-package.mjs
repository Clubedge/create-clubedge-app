#!/usr/bin/env node
// Imports the packed CLI by its package name, as a program that depends on it does: through the
// `exports` of its package.json, with the engine's types beside it. Usage:
//   node scripts/smoke-engine-package.mjs <unpacked package directory>
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const packageRoot = resolve(process.argv[2] ?? ".");
const name = "@clubedge/create-clubedge-app";
const consumer = await mkdtemp(join(tmpdir(), "clubedge-engine-smoke-"));

try {
  await mkdir(join(consumer, "node_modules", "@clubedge"), { recursive: true });
  // A junction on Windows, which needs no privileges there.
  await symlink(packageRoot, join(consumer, "node_modules", name), "junction");
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  await writeFile(join(consumer, "import.mjs"), `export * from "${name}";\n`);

  const engine = await import(pathToFileURL(join(consumer, "import.mjs")).href);
  const manifest = createRequire(join(consumer, "package.json"))(`${name}/package.json`);

  assert.equal(engine.REPORT_VERSION, 1);
  assert.equal(engine.version, manifest.version);
  assert.deepEqual(engine.starter, {
    repository: manifest.clubedge.starterRepository,
    ref: manifest.clubedge.starterRef,
    commit: manifest.clubedge.starterCommit,
  });
  for (const fn of ["upgradeProject", "addToProject", "removeFromProject", "readProjectRecord", "parseProjectRecord"]) {
    assert.equal(typeof engine[fn], "function", `${fn} is exported`);
  }
  assert.deepEqual(engine.parseProjectRecord(JSON.stringify({ clubedge: { starterRef: "v0.31.3", framework: "next", modules: { auth: "supabase" } } })), {
    repository: manifest.clubedge.starterRepository,
    ref: "v0.31.3",
    stacks: { framework: "next" },
    modules: { auth: "supabase" },
  });

  // A folder that is no project: the engine resolves a failed report, and writes nothing to stdout.
  const write = process.stdout.write;
  let printed = "";
  process.stdout.write = (chunk, ...rest) => {
    printed += String(chunk);
    return write.call(process.stdout, chunk, ...rest);
  };
  let report;
  try {
    report = await engine.upgradeProject(consumer, { install: "none" });
  } finally {
    process.stdout.write = write;
  }
  assert.equal(printed, "");
  assert.equal(report.outcome, "failed");
  assert.match(report.error.message, /No Clubedge project found here/);

  await access(join(packageRoot, manifest.exports["."].types));
  console.log(`${name} ${manifest.version}: the engine imports by its package name, with its types.`);
} finally {
  await rm(consumer, { recursive: true, force: true });
}
