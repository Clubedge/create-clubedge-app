import { describe, expect, it } from "vitest";
import {
  applyConditionals,
  ConditionalError,
  customizeAppManifest,
  customizeLegacySource,
  customizeLockfile,
  customizeReadme,
  customizeRootManifest,
  customizeSiteConfig,
  removePackageDependencies,
  type Provenance,
} from "../src/core/customize.js";
import { lockfile, modulesLockfile, siteConfig } from "./helpers.js";

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

describe("applyConditionals", () => {
  const selection = { framework: "next", auth: "none", storage: "s3" };

  it("keeps matching blocks, drops the rest, and removes every marker", () => {
    const source = [
      "start",
      "# clubedge:if auth=supabase",
      "SUPABASE_URL=",
      "# clubedge:end",
      "// clubedge:if storage=s3|supabase",
      "storage();",
      "// clubedge:end",
      "<!-- clubedge:if framework!=next -->",
      "TanStack only",
      "<!-- clubedge:end -->",
      "{/* clubedge:if auth=none && storage=s3 */}",
      "<p>Both</p>",
      "{/* clubedge:end */}",
      "end",
    ].join("\n");
    expect(applyConditionals(source, selection)).toBe("start\nstorage();\n<p>Both</p>\nend");
  });

  it("always drops Starter-repository-only sections", () => {
    const source = "a\n<!-- clubedge:if starter-repository -->\nMaintainers only.\n<!-- clubedge:end -->\nb";
    expect(applyConditionals(source, selection)).toBe("a\nb");
  });

  it("returns sources without markers unchanged", () => {
    expect(applyConditionals("a\n\n\nb", selection)).toBe("a\n\n\nb");
  });

  it("collapses the blank lines a removed block leaves behind", () => {
    const source = "intro\n\n<!-- clubedge:if auth=supabase -->\nSetup.\n<!-- clubedge:end -->\n\noutro\n";
    expect(applyConditionals(source, selection)).toBe("intro\n\noutro\n");
  });

  it.each([
    ["an unknown key", "# clubedge:if cache=redis\n# clubedge:end", "unknown key \"cache\""],
    ["an unreadable condition", "# clubedge:if auth\n# clubedge:end", "cannot read the condition"],
    ["a nested block", "# clubedge:if auth=none\n# clubedge:if storage=s3\n# clubedge:end\n# clubedge:end", "cannot nest"],
    ["an unclosed block", "# clubedge:if auth=none\nx", "never closed"],
    ["a stray end", "x\n# clubedge:end", "without clubedge:if"],
  ])("rejects %s with its location", (_label, source, message) => {
    expect(() => applyConditionals(source, selection, "README.md")).toThrow(ConditionalError);
    expect(() => applyConditionals(source, selection, "README.md")).toThrow(message);
    expect(() => applyConditionals(source, selection, "README.md")).toThrow(/^README\.md:\d+:/);
  });
});

describe("removePackageDependencies", () => {
  it("removes left-out packages from every dependency field", () => {
    const source = JSON.stringify({
      name: "@clubedge/web",
      dependencies: { "@clubedge/storage-s3": "workspace:*", zod: "^4" },
      devDependencies: { "@clubedge/storage-s3": "workspace:*" },
    });
    expect(JSON.parse(removePackageDependencies(source, ["@clubedge/storage-s3"]))).toEqual({
      name: "@clubedge/web",
      dependencies: { zod: "^4" },
      devDependencies: {},
    });
  });

  it("leaves a manifest without those dependencies byte-for-byte unchanged", () => {
    const source = '{"name":"x","dependencies":{"zod":"^4"}}';
    expect(removePackageDependencies(source, ["@clubedge/storage-s3"])).toBe(source);
  });
});

describe("customizeLockfile with left-out packages", () => {
  it("drops their importers and every dependency entry pointing at them", () => {
    const result = customizeLockfile(modulesLockfile, {
      remove: ["apps/web", "packages/auth-supabase", "packages/storage-s3", "packages/storage-supabase"],
      rename: { from: "apps/start", to: "apps/web" },
      removeDependencies: ["@clubedge/auth-supabase", "@clubedge/storage-s3", "@clubedge/storage-supabase"],
    });

    expect(result).toBe(`lockfileVersion: '9.0'

importers:

  .: {}

  apps/web:
    dependencies:
      '@tanstack/react-start':
        specifier: 1.168.61
        version: 1.168.61

packages:

  next@16.1.0:
    resolution: {integrity: sha512-x}
`);
  });

  it("drops a dependency group whose entries were all removed", () => {
    const source = "importers:\n\n  apps/web:\n    dependencies:\n      '@clubedge/storage-s3':\n        specifier: workspace:*\n        version: link:../../packages/storage-s3\n    devDependencies:\n      typescript:\n        specifier: ^5\n        version: 5.9.2\n\npackages: {}\n";
    expect(customizeLockfile(source, { remove: [], removeDependencies: ["@clubedge/storage-s3"] })).toBe(
      "importers:\n\n  apps/web:\n    devDependencies:\n      typescript:\n        specifier: ^5\n        version: 5.9.2\n\npackages: {}\n",
    );
  });
});
