import { describe, expect, it, vi } from "vitest";
import {
  checkConflicts,
  checkEnvFile,
  checkLockfile,
  checkNode,
  checkPnpm,
  compareVersions,
  fetchLatestRelease,
  nextStep,
  updateState,
} from "../src/core/health.js";

describe("compareVersions", () => {
  it("orders release tags and plain versions", () => {
    expect(compareVersions("v0.13.1", "v0.12.0")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0", "v0.10.0")).toBeLessThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });

  it("refuses branches, commits, and partial versions", () => {
    expect(compareVersions("main", "v0.13.0")).toBeNull();
    expect(compareVersions("v0.13", "v0.13.0")).toBeNull();
  });
});

describe("fetchLatestRelease", () => {
  it("reads the newest CLI and its Starter pin from npm", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ version: "0.14.1", clubedge: { starterRef: "v0.13.1", starterCommit: "abc" } }),
    );
    await expect(fetchLatestRelease(fetcher as unknown as typeof fetch)).resolves.toEqual({
      cliVersion: "0.14.1",
      starterRef: "v0.13.1",
    });
  });

  it("resolves null when npm fails or answers something else", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(fetchLatestRelease(offline as unknown as typeof fetch)).resolves.toBeNull();
    const notFound = vi.fn(async () => new Response("", { status: 404 }));
    await expect(fetchLatestRelease(notFound as unknown as typeof fetch)).resolves.toBeNull();
    const unexpected = vi.fn(async () => Response.json({ version: "0.14.1" }));
    await expect(fetchLatestRelease(unexpected as unknown as typeof fetch)).resolves.toBeNull();
  });
});

describe("updateState and nextStep", () => {
  const latest = { cliVersion: "0.14.1", starterRef: "v0.13.1" };

  it("offers an upgrade when a newer Starter release exists", () => {
    const update = updateState("v0.12.0", latest);
    expect(update).toEqual({ kind: "available", ...latest });
    expect(nextStep({ kind: "clean" }, update, "pnpm clubedge")).toBe(
      "Run `pnpm clubedge upgrade` to move to Starter v0.13.1.",
    );
    expect(nextStep({ kind: "dirty", files: 2 }, update, "pnpm clubedge")).toMatch(/^Commit or stash/);
    // Without the clubedge script, the newest CLI has to be asked for explicitly.
    expect(nextStep({ kind: "clean" }, update, "pnpm dlx @clubedge/create-clubedge-app")).toContain(
      "pnpm dlx @clubedge/create-clubedge-app@latest upgrade",
    );
  });

  it("reports a project on the newest release, or one it cannot compare", () => {
    expect(updateState("v0.13.1", latest)).toEqual({ kind: "current" });
    expect(updateState("main", latest)).toEqual({ kind: "unknown" });
    expect(updateState("v0.13.1", null)).toEqual({ kind: "unknown" });
    expect(nextStep({ kind: "clean" }, { kind: "current" }, "pnpm clubedge")).toContain("pnpm clubedge doctor");
    expect(nextStep({ kind: "none" }, { kind: "unknown" }, "pnpm clubedge")).toMatch(/^Could not check/);
  });
});

describe("doctor checks", () => {
  it("checks Node.js against the project's engines field", () => {
    expect(checkNode("22.12.0", ">=22.12.0").status).toBe("ok");
    expect(checkNode("24.1.0", ">=22.12.0").status).toBe("ok");
    expect(checkNode("22.11.0", ">=22.12.0")).toMatchObject({ status: "fail", fix: expect.stringContaining("22.12.0") });
    expect(checkNode("20.0.0", undefined).status).toBe("fail");
  });

  it("checks pnpm against packageManager", () => {
    expect(checkPnpm("10.9.0", "pnpm@10.9.0").status).toBe("ok");
    expect(checkPnpm("10.18.2", "pnpm@10.9.0").status).toBe("ok");
    expect(checkPnpm("9.15.0", "pnpm@10.9.0").status).toBe("warn");
    expect(checkPnpm(null, "pnpm@10.9.0")).toMatchObject({ status: "fail", fix: expect.stringContaining("corepack") });
  });

  it("compares the local env file with the example", () => {
    const paths = { example: ".env.example", local: "apps/web/.env.local" };
    expect(checkEnvFile("A=\nB=1\n", null, paths)).toMatchObject({ status: "fail" });
    expect(checkEnvFile("A=\nB=1\n", "B=2\nA=x\n", paths).status).toBe("ok");
    const drift = checkEnvFile("# comment\nA=\nB=\n", "A=1\nOLD=2\n", paths);
    expect(drift.status).toBe("warn");
    expect(drift.detail).toContain("missing B");
    expect(drift.detail).toContain("not in .env.example: OLD");
  });

  it("reads pnpm's frozen lockfile result", () => {
    expect(checkLockfile(null).status).toBe("ok");
    expect(
      checkLockfile('ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date'),
    ).toMatchObject({ status: "fail", fix: expect.stringContaining("pnpm install") });
    expect(checkLockfile("\nERR_PNPM_NO_OFFLINE_META  Failed to resolve\n")).toMatchObject({
      status: "warn",
      detail: "could not check: ERR_PNPM_NO_OFFLINE_META  Failed to resolve",
    });
  });

  it("checks for unresolved conflict markers", () => {
    expect(checkConflicts([])).toEqual({
      name: "Conflicts",
      status: "ok",
      detail: "no unresolved conflict markers",
    });

    const single = checkConflicts([{ path: "apps/web/src/server/cache.ts", blocks: 1 }]);
    expect(single.status).toBe("fail");
    expect(single.detail).toContain("1 file has unresolved conflict markers (1 total)");
    expect(single.detail).toContain("apps/web/src/server/cache.ts (1 block)");

    const multiple = checkConflicts([
      { path: "a.ts", blocks: 2 },
      { path: "b.ts", blocks: 3 },
    ]);
    expect(multiple.status).toBe("fail");
    expect(multiple.detail).toContain("2 files have unresolved conflict markers (5 total)");
    expect(multiple.detail).toContain("a.ts (2 blocks)");
    expect(multiple.detail).toContain("b.ts (3 blocks)");

    const many = checkConflicts(
      Array.from({ length: 7 }, (_, i) => ({ path: `file${i}.ts`, blocks: 1 })),
    );
    expect(many.detail).toContain("... and 2 more files");
  });
});

