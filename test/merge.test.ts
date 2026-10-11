import { describe, expect, it } from "vitest";
import { mergeText, planMerge, type FileMap, type MergeAction } from "../src/core/merge.js";

const files = (entries: Record<string, string | Buffer>): FileMap =>
  new Map(Object.entries(entries).map(([path, content]) => [path, Buffer.from(content)]));

const summary = (actions: MergeAction[]) =>
  actions.map((action) => ({
    path: action.path,
    kind: action.kind,
    ...("content" in action ? { content: action.content.toString() } : {}),
  }));

describe("planMerge", () => {
  it("applies the target to files the project never changed", () => {
    const base = files({ "a.ts": "one\n", "gone.ts": "old\n", "same.ts": "x\n" });
    const target = files({ "a.ts": "two\n", "new.ts": "fresh\n", "same.ts": "x\n" });
    const current = files({ "a.ts": "one\n", "gone.ts": "old\n", "same.ts": "x\n", "mine.ts": "user\n" });

    expect(summary(planMerge(base, target, current))).toEqual([
      { path: "a.ts", kind: "update", content: "two\n" },
      { path: "gone.ts", kind: "delete" },
      { path: "new.ts", kind: "create", content: "fresh\n" },
    ]);
  });

  it("merges the project's edits with the target's changes", () => {
    const base = files({ "env.ts": "a\nb\nc\nd\ne\n" });
    const target = files({ "env.ts": "a\nb\nc\nd\ne\nredis\n" });
    const current = files({ "env.ts": "a\nmine\nc\nd\ne\n" });

    expect(summary(planMerge(base, target, current))).toEqual([
      { path: "env.ts", kind: "merge", content: "a\nmine\nc\nd\ne\nredis\n" },
    ]);
  });

  it("marks lines both sides changed as a conflict", () => {
    const base = files({ "page.tsx": "title\nbody\n" });
    const target = files({ "page.tsx": "new title\nbody\n" });
    const current = files({ "page.tsx": "my title\nbody\n" });

    expect(summary(planMerge(base, target, current))).toEqual([
      {
        path: "page.tsx",
        kind: "conflict",
        content: "<<<<<<< yours\nmy title\n=======\nnew title\n>>>>>>> clubedge\nbody\n",
      },
    ]);
  });

  it("does nothing when the project already matches the target", () => {
    const base = files({ "a.ts": "one\n" });
    const target = files({ "a.ts": "two\n", "b.ts": "b\n" });
    expect(planMerge(base, target, files({ "a.ts": "two\n", "b.ts": "b\n" }))).toEqual([]);
  });

  it("keeps changed files the target removes, and reports files the project deleted", () => {
    const base = files({ "edited.ts": "old\n", "deleted.ts": "v1\n" });
    const target = files({ "deleted.ts": "v2\n" });
    const current = files({ "edited.ts": "old\nmy change\n" });

    expect(planMerge(base, target, current).map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: "deleted.ts", kind: "keep" },
      { path: "edited.ts", kind: "keep" },
    ]);
  });

  it("leaves files the project deleted alone when the target removes them too", () => {
    expect(planMerge(files({ "a.ts": "a\n" }), files({}), files({}))).toEqual([]);
  });

  it("merges a file the target adds with the project's own file of that name", () => {
    const actions = planMerge(files({}), files({ "new.ts": "theirs\n" }), files({ "new.ts": "mine\n" }));
    expect(actions[0]?.kind).toBe("conflict");
  });

  it("keeps CRLF line endings and treats them as unchanged", () => {
    const base = files({ "a.ts": "one\ntwo\n" });
    const target = files({ "a.ts": "one\nthree\n" });
    const crlf = files({ "a.ts": "one\r\ntwo\r\n" });

    expect(summary(planMerge(base, target, crlf))).toEqual([
      { path: "a.ts", kind: "update", content: "one\r\nthree\r\n" },
    ]);
    expect(planMerge(base, base, crlf)).toEqual([]);
  });

  it("copies binary files byte for byte and never merges them", () => {
    const image = (byte: number) => Buffer.from([0x89, 0x50, 0x00, byte, 0x0a, 0x0d, 0x0a]);
    const base = new Map([["logo.png", image(1)]]);
    const target = new Map([["logo.png", image(2)]]);

    const update = planMerge(base, target, new Map([["logo.png", image(1)]]));
    expect(update).toEqual([{ path: "logo.png", kind: "update", content: image(2) }]);

    const edited = planMerge(base, target, new Map([["logo.png", image(3)]]));
    expect(edited.map(({ kind }) => kind)).toEqual(["keep"]);
  });
});

describe("mergeText", () => {
  it("accepts the same change made on both sides", () => {
    const result = mergeText(Buffer.from("a\nX\nc\n"), Buffer.from("a\nb\nc\n"), Buffer.from("a\nX\nc\n"));
    expect(result).toEqual({ text: "a\nX\nc\n", conflict: false });
  });
});
