import { describe, expect, it } from "vitest";
import {
  customizeAppManifest,
  customizeLegacySource,
  customizeLockfile,
  customizeReadme,
  customizeRootManifest,
  customizeSiteConfig,
  type Provenance,
} from "../src/core/customize.js";
import { lockfile, siteConfig } from "./helpers.js";

const identity = { packageName: "my-product", displayName: "My Product" };
const provenance: Provenance = {
  cliVersion: "9.9.9",
  starterRepository: "Clubedge/clubedge-starter",
  starterRef: "v0.3.0",
  starterCommit: "a".repeat(40),
};

describe("customizeRootManifest", () => {
  it("names the package, records provenance, and renames the Docker image", () => {
    const source = JSON.stringify({
      name: "clubedge-starter-v1",
      private: true,
      scripts: {
        "docker:build": "docker build -t clubedge-starter .",
        "docker:start": "docker run --rm clubedge-starter",
        dev: "turbo run dev",
      },
    });

    const result = JSON.parse(customizeRootManifest(source, identity, provenance, "clubedge-starter"));

    expect(result.name).toBe("my-product");
    expect(result.private).toBe(true);
    expect(result.clubedge).toEqual(provenance);
    expect(result.scripts["docker:build"]).toBe("docker build -t my-product .");
    expect(result.scripts["docker:start"]).toBe("docker run --rm my-product");
    expect(result.scripts.dev).toBe("turbo run dev");
  });

  it("omits the commit when it is unknown and ends with a newline", () => {
    const { starterCommit: _omit, ...withoutCommit } = provenance;
    const output = customizeRootManifest("{}", identity, withoutCommit, "clubedge-starter");
    expect(JSON.parse(output).clubedge).not.toHaveProperty("starterCommit");
    expect(output.endsWith("}\n")).toBe(true);
  });
});

describe("customizeReadme", () => {
  it("retitles the first heading only and records the origin", () => {
    const readme = customizeReadme("# Clubedge Starter\n\nIntro.\n\n# Later\n", identity, provenance);
    expect(readme).toMatch(/^# My Product\n\n## Generated from\n/);
    expect(readme).toContain("- Starter ref: `v0.3.0`");
    expect(readme).toContain(`- Starter commit: \`${"a".repeat(40)}\``);
    expect(readme).toContain("- CLI version: `9.9.9`");
    expect(readme).toContain("\n# Later\n");
  });
});

describe("customizeSiteConfig", () => {
  it("rewrites identity fields and keeps the rest", () => {
    const result = JSON.parse(customizeSiteConfig(JSON.stringify(siteConfig), identity));
    expect(result).toEqual({
      name: "My Product",
      shortName: "My Product",
      description: "My Product application foundation.",
      serviceId: "my-product",
      workspaceLabel: "Application workspace",
      links: siteConfig.links,
    });
  });
});

describe("customizeLegacySource", () => {
  it("replaces Starter v0.1.x branding in source files", () => {
    const source =
      'title: { default: "Clubedge Starter", template: "%s · Clubedge Starter" }, ' +
      'description: "A production-minded foundation for Clubedge applications." ' +
      "<span>Clubedge</span><span>Starter workspace</span>";

    const result = customizeLegacySource(source, identity);

    expect(result).toContain('default: "My Product"');
    expect(result).toContain("%s · My Product");
    expect(result).toContain("My Product application foundation.");
    expect(result).toContain("<span>My Product</span><span>Application workspace</span>");
    expect(result).not.toMatch(/Clubedge Starter|>Clubedge</);
  });
});

describe("customizeLockfile", () => {
  it("drops the apps that were left out and renames the selected one", () => {
    const result = customizeLockfile(lockfile, {
      remove: ["apps/web"],
      rename: { from: "apps/start", to: "apps/web" },
    });

    expect(result).toBe(`lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      turbo:
        specifier: ^2.5.0
        version: 2.5.0

  apps/web:
    dependencies:
      '@tanstack/react-start':
        specifier: 1.168.61
        version: 1.168.61

  packages/core: {}

packages:

  next@16.1.0:
    resolution: {integrity: sha512-x}
`);
  });

  it("only touches importers, never package entries", () => {
    const result = customizeLockfile(lockfile, { remove: ["apps/start", "next@16.1.0"] });
    expect(result).not.toContain("apps/start:");
    expect(result).toContain("  apps/web:\n");
    expect(result).toContain("  next@16.1.0:\n");
  });
});

describe("customizeAppManifest", () => {
  it("renames the app package and keeps everything else", () => {
    const result = JSON.parse(
      customizeAppManifest(JSON.stringify({ name: "@clubedge/start", private: true }), "@clubedge/web"),
    );
    expect(result).toEqual({ name: "@clubedge/web", private: true });
  });
});

describe("framework provenance", () => {
  const withFramework: Provenance = { ...provenance, framework: "tanstack-start", frameworkName: "TanStack Start" };

  it("records the framework id in package.json", () => {
    const result = JSON.parse(
      customizeRootManifest(JSON.stringify({ name: "x" }), identity, withFramework, "clubedge-starter"),
    );
    expect(result.clubedge.framework).toBe("tanstack-start");
    expect(result.clubedge.frameworkName).toBeUndefined();
  });

  it("names the framework in the README", () => {
    expect(customizeReadme("# Clubedge Starter\n", identity, withFramework)).toContain(
      "- Framework: TanStack Start\n",
    );
  });
});
