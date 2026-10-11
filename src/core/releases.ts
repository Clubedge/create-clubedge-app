// The Starter releases an upgrade crosses, from GitHub, so `upgrade` can say what changed before
// the developer reviews `git diff`.
import { compareVersions } from "./health.js";

export interface Release {
  tag: string;
  name: string;
  body: string;
}

/**
 * The repository's published releases, newest first. Resolves null when GitHub cannot be reached
 * in time or refuses, so an upgrade never depends on it. GITHUB_TOKEN raises the rate limit.
 */
export async function fetchReleases(
  repository: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<Release[] | null> {
  try {
    const token = process.env.GITHUB_TOKEN;
    const response = await fetcher(`https://api.github.com/repos/${repository}/releases?per_page=100`, {
      headers: {
        accept: "application/vnd.github+json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const releases = (await response.json()) as Array<{
      tag_name?: unknown;
      name?: unknown;
      body?: unknown;
      draft?: unknown;
      prerelease?: unknown;
    }>;
    if (!Array.isArray(releases)) return null;
    return releases
      .filter((release) => typeof release.tag_name === "string" && !release.draft && !release.prerelease)
      .map((release) => ({
        tag: release.tag_name as string,
        name: typeof release.name === "string" && release.name ? release.name : (release.tag_name as string),
        body: typeof release.body === "string" ? release.body : "",
      }));
  } catch {
    return null;
  }
}

/** Releases after `from`, up to and including `to`, oldest first. */
export function releasesBetween(releases: Release[], from: string, to: string): Release[] {
  return releases
    .filter((release) => {
      const afterFrom = compareVersions(release.tag, from);
      const upToTo = compareVersions(release.tag, to);
      return afterFrom !== null && upToTo !== null && afterFrom > 0 && upToTo <= 0;
    })
    .sort((a, b) => compareVersions(a.tag, b.tag)!);
}

/** The second-level headings of release notes, such as "Background jobs" and "Tests". */
export function releaseHeadings(body: string): string[] {
  return body
    .split(/\r?\n/)
    .flatMap((line) => /^##\s+(.+?)\s*#*\s*$/.exec(line)?.[1] ?? []);
}

/** One line per release: its tag and what its notes cover. */
export function describeReleases(releases: Release[]): string {
  return releases
    .map((release) => {
      const headings = releaseHeadings(release.body);
      return `${release.tag}  ${headings.length ? headings.join(", ") : release.name}`;
    })
    .join("\n");
}
