import { describe, expect, it, vi } from "vitest";
import { countConflicts } from "../src/core/merge.js";
import { describeReleases, fetchReleases, releaseHeadings, releasesBetween, type Release } from "../src/core/releases.js";

const release = (tag: string, body = ""): Release => ({ tag, name: tag, body });

describe("fetchReleases", () => {
  it("keeps published releases and drops drafts and prereleases", async () => {
    const fetcher = vi.fn(async () =>
      Response.json([
        { tag_name: "v0.13.1", name: "v0.13.1", body: "## Fix\n" },
        { tag_name: "v0.14.0-rc.1", name: "", body: "", prerelease: true },
        { tag_name: "v0.15.0", name: "", body: "", draft: true },
        { name: "no tag" },
      ]),
    );
    await expect(fetchReleases("Clubedge/clubedge-starter", fetcher as unknown as typeof fetch)).resolves.toEqual([
      { tag: "v0.13.1", name: "v0.13.1", body: "## Fix\n" },
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/repos/Clubedge/clubedge-starter/releases?per_page=100",
      expect.objectContaining({ headers: expect.objectContaining({ accept: "application/vnd.github+json" }) }),
    );
  });

  it("resolves null when GitHub cannot be reached or refuses", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(fetchReleases("a/b", offline as unknown as typeof fetch)).resolves.toBeNull();
    const limited = vi.fn(async () => new Response("rate limited", { status: 403 }));
    await expect(fetchReleases("a/b", limited as unknown as typeof fetch)).resolves.toBeNull();
  });
});

describe("releasesBetween", () => {
  it("takes the releases after the project's and up to the target, oldest first", () => {
    const releases = [release("v0.13.1"), release("v0.13.0"), release("v0.12.0"), release("v0.11.0"), release("main")];
    expect(releasesBetween(releases, "v0.11.0", "v0.13.0").map((r) => r.tag)).toEqual(["v0.12.0", "v0.13.0"]);
    expect(releasesBetween(releases, "v0.13.1", "v0.13.1")).toEqual([]);
  });
});

describe("release summaries", () => {
  it("lists each release's second-level headings, or its name without any", () => {
    expect(releaseHeadings("Intro\n## Background jobs\n- item\n## Tests ##\n### Detail\n")).toEqual([
      "Background jobs",
      "Tests",
    ]);
    expect(describeReleases([release("v0.12.0", "## Background jobs\n## Tests\n"), release("v0.12.1", "Fixes only.")])).toBe(
      "v0.12.0  Background jobs, Tests\nv0.12.1  v0.12.1",
    );
  });
});

describe("countConflicts", () => {
  it("counts conflict blocks in LF and CRLF files", () => {
    const block = "<<<<<<< yours\nmine\n=======\ntheirs\n>>>>>>> clubedge\n";
    expect(countConflicts(Buffer.from(`a\n${block}b\n${block}`))).toBe(2);
    expect(countConflicts(Buffer.from(`a\r\n${block.replace(/\n/g, "\r\n")}`))).toBe(1);
    expect(countConflicts(Buffer.from("no conflicts\n"))).toBe(0);
  });
});
