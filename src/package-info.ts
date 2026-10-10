import { readFileSync } from "node:fs";

interface CliPackageJson {
  version: string;
  clubedge: { starterRepository: string; starterRef: string; starterCommit: string };
}

// package.json is the single source for the version and the tested Starter pin. It ships
// with the package, so the npm registry exposes exactly what each release scaffolds.
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as CliPackageJson;

export const cliVersion = packageJson.version;
export const starterPin = packageJson.clubedge;
export const siteUrl = "https://clubedge.live";
export const cliUrl = "https://starter.clubedge.live";
