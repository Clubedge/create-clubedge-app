import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  applyPlugins,
  loadPluginFromDirectory,
  parseArguments,
  parsePluginSpec,
} from "../bin/create.mjs";

const temporaryDirectories = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "create-clubedge-app-plugins-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("--with", () => {
  it("collects repeated plugins in order", () => {
    const options = parseArguments(["my-app", "--with", "@scope/one@1.2.3", "--with=two@0.1.0-beta.1"]);
    assert.deepEqual(options.plugins, [
      { name: "@scope/one", version: "1.2.3" },
      { name: "two", version: "0.1.0-beta.1" },
    ]);
    assert.equal(options.projectDirectory, "my-app");
  });

  it("defaults to no plugins", () => {
    assert.deepEqual(parseArguments(["my-app"]).plugins, []);
  });

  it("requires a value", () => {
    assert.throws(() => parseArguments(["--with"]), /--with requires/);
    assert.throws(() => parseArguments(["--with", "--no-git"]), /--with requires/);
  });

  it("rejects plugins that are not pinned to an exact version", () => {
    for (const spec of ["@scope/one", "one@latest", "one@^1.2.3", "one@1.2", "https://example.com/x.tgz"]) {
      assert.throws(() => parsePluginSpec(spec), /exact version/, spec);
    }
  });
});

describe("loadPluginFromDirectory", () => {
  it("imports the entry declared in clubedge.plugin", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "@scope/one", version: "1.2.3", clubedge: { plugin: "./plugin.mjs" } }),
    );
    await writeFile(join(directory, "plugin.mjs"), "export async function apply() { return 'applied'; }\n");

    const plugin = await loadPluginFromDirectory(directory);
    assert.equal(plugin.name, "@scope/one");
    assert.equal(plugin.version, "1.2.3");
    assert.equal(await plugin.apply(), "applied");
  });

  it("refuses a package that does not declare a plugin entry", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "lodash", version: "4.17.21" }));
    await assert.rejects(loadPluginFromDirectory(directory), /not a create-clubedge-app plugin/);
  });

  it("refuses an entry without apply()", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "one", version: "1.0.0", clubedge: { plugin: "./plugin.mjs" } }),
    );
    await writeFile(join(directory, "plugin.mjs"), "export const nothing = 1;\n");
    await assert.rejects(loadPluginFromDirectory(directory), /does not export an apply\(\) function/);
  });
});

describe("applyPlugins", () => {
  it("runs plugins in order and records them after their own manifest edits", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "my-product", clubedge: { cliVersion: "0.1.13", starterRef: "v0.1.1" } }),
    );
    const calls = [];
    const fakeApply = async (plugin, context) => {
      calls.push([plugin.name, context.directory, context.packageName]);
      const manifestPath = join(context.directory, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.dependencies = { ...manifest.dependencies, [plugin.name]: plugin.version };
      await writeFile(manifestPath, JSON.stringify(manifest));
      return plugin;
    };

    await applyPlugins(
      directory,
      [
        { name: "@scope/one", version: "1.2.3" },
        { name: "two", version: "0.1.0" },
      ],
      { packageName: "my-product" },
      fakeApply,
    );

    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    assert.deepEqual(calls, [
      ["@scope/one", directory, "my-product"],
      ["two", directory, "my-product"],
    ]);
    assert.deepEqual(manifest.dependencies, { "@scope/one": "1.2.3", two: "0.1.0" });
    assert.deepEqual(manifest.clubedge, {
      cliVersion: "0.1.13",
      starterRef: "v0.1.1",
      plugins: [
        { name: "@scope/one", version: "1.2.3" },
        { name: "two", version: "0.1.0" },
      ],
    });
  });

  it("leaves the manifest untouched when no plugins are requested", async () => {
    const directory = await temporaryDirectory();
    const original = JSON.stringify({ name: "my-product", clubedge: { cliVersion: "0.1.13" } });
    await writeFile(join(directory, "package.json"), original);
    await applyPlugins(directory, [], {});
    assert.equal(await readFile(join(directory, "package.json"), "utf8"), original);
  });

  it("names the plugin that failed", async () => {
    const directory = await temporaryDirectory();
    await mkdir(directory, { recursive: true });
    await assert.rejects(
      applyPlugins(directory, [{ name: "bad", version: "1.0.0" }], {}, async () => {
        throw new Error("boom");
      }),
      /Plugin bad@1\.0\.0 failed: boom/,
    );
  });
});
