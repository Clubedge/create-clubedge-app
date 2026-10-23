// Types for release-lib.mjs, so the tests type-check.
export interface Pin {
  ref: string;
  commit: string;
}
export interface PullRequest {
  number: number;
  title: string;
}
export function bumpVersion(version: string, kind: string): string;
export function updateVersionDocs(
  docs: { readme: string; contributing: string },
  from: string,
  to: string,
): { readme: string; contributing: string };
export function updatePinDocs(
  docs: { readme: string; contributing: string },
  from: Pin,
  to: Pin,
): { readme: string; contributing: string };
export function mergedPullRequests(log: string): PullRequest[];
export function changelogLine(title: string): string;
export function releaseSummary(pullRequests: PullRequest[]): string;
export function changelogEntry(version: string, pullRequests: PullRequest[], starterRef: string, pinChanged: boolean): string;
export function insertChangelog(changelog: string, entry: string): string;
export function changelogSection(changelog: string, version: string): string;
export function addRoadmapRows(
  docs: { readme: string; roadmap: string },
  version: string,
  starterRef: string,
  summary: string,
): { readme: string; roadmap: string };
