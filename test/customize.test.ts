import { describe, expect, it } from "vitest";
import {
  customizeLegacySource,
  customizeReadme,
  customizeRootManifest,
  customizeSiteConfig,
  type Provenance,
} from "../src/core/customize.js";
import { siteConfig } from "./helpers.js";

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
