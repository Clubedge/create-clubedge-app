// Three-way merge between what the CLI generated (base), what it would generate now (target),
// and the project as it is (current). Changes from base to target are applied to the project
// without losing the project's own edits. Pure: callers read and write the files.
import { diff3Merge } from "node-diff3";

export type FileMap = Map<string, Buffer>;

export type MergeAction =
  /** The target adds the file and the project does not have it. */
  | { path: string; kind: "create"; content: Buffer }
  /** The project still has the generated version, so it takes the target's. */
  | { path: string; kind: "update"; content: Buffer }
  /** Both changed the file in different places; the result combines them. */
  | { path: string; kind: "merge"; content: Buffer }
  /** Both changed the same lines; the result has conflict markers to resolve. */
  | { path: string; kind: "conflict"; content: Buffer }
  /** The target drops the file and the project never changed it. */
  | { path: string; kind: "delete" }
  /** Left as it is; `reason` says why and what to check by hand. */
  | { path: string; kind: "keep"; reason: string };

export const CONFLICT_LABELS = { yours: "yours", theirs: "clubedge" } as const;

function isBinary(content: Buffer) {
  return content.subarray(0, 8000).includes(0);
}

function normalize(content: Buffer) {
  return content.toString("utf8").replace(/\r\n/g, "\n");
}

function usesCrlf(content: Buffer) {
  return content.includes("\r\n");
}

/** The text in the project's line endings: a project checked out with CRLF keeps CRLF. */
function withLineEndings(text: string, like: Buffer | undefined) {
  return Buffer.from(like && usesCrlf(like) ? text.replace(/\n/g, "\r\n") : text);
}

/** Equal content, ignoring CRLF versus LF line endings in text files. */
export function sameContent(a: Buffer, b: Buffer) {
  if (isBinary(a) || isBinary(b)) return a.equals(b);
  return normalize(a) === normalize(b);
}

/** Merges base -> target into current. Resolves null for binary files, which cannot be merged. */
export function mergeText(
  current: Buffer,
  base: Buffer,
  target: Buffer,
): { text: string; conflict: boolean } | null {
  if (isBinary(current) || isBinary(base) || isBinary(target)) return null;
  const split = (content: Buffer) => normalize(content).split("\n");
  const regions = diff3Merge(split(current), split(base), split(target), { excludeFalseConflicts: true });
  const lines: string[] = [];
  let conflict = false;
  for (const region of regions) {
    if (region.ok) {
      lines.push(...region.ok);
      continue;
    }
    if (!region.conflict) continue;
    conflict = true;
    lines.push(
      `<<<<<<< ${CONFLICT_LABELS.yours}`,
      ...region.conflict.a,
      "=======",
      ...region.conflict.b,
      `>>>>>>> ${CONFLICT_LABELS.theirs}`,
    );
  }
  return { text: lines.join("\n"), conflict };
}

function merged(path: string, current: Buffer, base: Buffer, target: Buffer, binaryReason: string): MergeAction {
  const result = mergeText(current, base, target);
  if (!result) return { path, kind: "keep", reason: binaryReason };
  const content = withLineEndings(result.text, current);
  return { path, kind: result.conflict ? "conflict" : "merge", content };
}

/**
 * Decides what happens to every file the base or the target contains. Files only the project
 * has are never touched. Actions come back sorted by path.
 */
export function planMerge(base: FileMap, target: FileMap, current: FileMap): MergeAction[] {
  const paths = [...new Set([...base.keys(), ...target.keys()])].sort();
  const actions: MergeAction[] = [];

  for (const path of paths) {
    const before = base.get(path);
    const after = target.get(path);
    const mine = current.get(path);
    if (before && after && sameContent(before, after)) continue;

    if (!before && after) {
      if (!mine) actions.push({ path, kind: "create", content: after });
      else if (!sameContent(mine, after)) {
        actions.push(merged(path, mine, Buffer.alloc(0), after, "Your file differs from the one the new selection adds."));
      }
      continue;
    }

    if (before && !after) {
      if (!mine) continue;
      if (sameContent(mine, before)) actions.push({ path, kind: "delete" });
      else actions.push({ path, kind: "keep", reason: "You changed this file, and the new selection no longer includes it. Delete it if nothing uses it." });
      continue;
    }

    if (before && after) {
      if (!mine) {
        actions.push({ path, kind: "keep", reason: "You deleted this file, and the new selection changes it. Restore it if you need the change." });
      } else if (sameContent(mine, before)) {
        const content = isBinary(after) ? after : withLineEndings(normalize(after), mine);
        actions.push({ path, kind: "update", content });
      } else if (!sameContent(mine, after)) {
        actions.push(merged(path, mine, before, after, "You changed this file, and the new selection changes it too."));
      }
    }
  }
  return actions;
}
