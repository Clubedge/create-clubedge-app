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

  it("leaves out a merge that changes nothing: the project already has the target's change", () => {
    // As in apps built alongside the Starter, which took some of their code: the same line, and more.
    const base = files({ "env.ts": "a\nb\nc\nd\ne\n", "package.json": '{\n  "name": "web",\n  "dependencies": { "a": "^1.0.0" }\n}\n' });
    const target = files({ "env.ts": "a\nB\nc\nd\ne\n", "package.json": '{\n  "name": "web",\n  "dependencies": { "a": "^1.1.0" }\n}\n' });
    const current = files({
      "env.ts": "a\nB\nc\nd\nmine\n",
      "package.json": '{\n  "name": "web",\n  "dependencies": {\n    "a": "^1.1.0",\n    "b": "^2.0.0"\n  }\n}\n',
    });

    expect(planMerge(base, target, current)).toEqual([]);
    // In CRLF too.
    const crlf = new Map([...current].map(([path, content]) => [path, Buffer.from(content.toString().replace(/\n/g, "\r\n"))]));
    expect(planMerge(base, target, crlf)).toEqual([]);
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

  it("carries the Starter's whole new version of a conflicted file", () => {
    const [action] = planMerge(
      files({ "page.tsx": "title\nbody\n" }),
      files({ "page.tsx": "new title\nbody\nfooter\n" }),
      files({ "page.tsx": "my title\r\nbody\r\n" }),
    );
    expect(action?.kind).toBe("conflict");
    // In the project's line endings, like the merged file.
    expect(action?.kind === "conflict" && action.incoming.toString()).toBe("new title\r\nbody\r\nfooter\r\n");
  });

  it("carries the Starter's version of a file the project deleted", () => {
    const [action] = planMerge(files({ "a.ts": "v1\n" }), files({ "a.ts": "v2\n" }), files({}));
    expect(action?.kind === "keep" && action.incoming?.toString()).toBe("v2\n");
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

describe("conflict blocks", () => {
  const lines = (...items: string[]) => `${items.join("\n")}\n`;
  /** Merges base -> theirs into yours, each given as lines. */
  const merge = (yours: string[], base: string[], theirs: string[]) =>
    mergeText(Buffer.from(lines(...yours)), Buffer.from(lines(...base)), Buffer.from(lines(...theirs)))!;
  const block = (yours: string[], theirs: string[]) => ["<<<<<<< yours", ...yours, "=======", ...theirs, ">>>>>>> clubedge"];

  it("leave out the lines both sides share at their start and end, as Git does", () => {
    const shared = ["import { db } from './db';", "", "export async function load() {"];
    const result = merge(["a", ...shared, "  return db.mine();", "}", "z"], ["a", "b", "z"], ["a", ...shared, "  return db.theirs();", "}", "z"]);
    expect(result).toEqual({
      text: lines("a", ...shared, ...block(["  return db.mine();"], ["  return db.theirs();"]), "}", "z"),
      conflict: true,
    });
  });

  it("split where more than three shared lines with words separate the differences", () => {
    const shared = ["const first = 1;", "const second = 2;", "const third = 3;", "const fourth = 4;"];
    const result = merge(["a", "mine one", ...shared, "mine two", "z"], ["a", "b", "z"], ["a", "theirs one", ...shared, "theirs two", "z"]);
    expect(result.text).toBe(lines("a", ...block(["mine one"], ["theirs one"]), ...shared, ...block(["mine two"], ["theirs two"]), "z"));
  });

  it("stay one block across three shared lines or fewer, or shared lines without a letter or digit", () => {
    const close = merge(["a", "mine one", "x = 1", "y = 2", "mine two", "z"], ["a", "b", "z"], ["a", "theirs one", "x = 1", "y = 2", "theirs two", "z"]);
    expect(close.text).toBe(lines("a", ...block(["mine one", "x = 1", "y = 2", "mine two"], ["theirs one", "x = 1", "y = 2", "theirs two"]), "z"));

    const braces = ["  }", "", "}", "", ");"];
    const punctuation = merge(["a", "mine one", ...braces, "mine two", "z"], ["a", "b", "z"], ["a", "theirs one", ...braces, "theirs two", "z"]);
    expect(punctuation.text.match(/^<<<<<<< yours$/gm)).toHaveLength(1);
  });

  it("hold only a blank line when the sides differ only in blank lines", () => {
    const result = merge(["a", "one", "", "two", "z"], ["a", "b", "z"], ["a", "one", "two", "z"]);
    expect(result.text).toBe(lines("a", "one", ...block([""], []), "two", "z"));
  });

  it("keep a side that is empty whole", () => {
    const result = merge(["a", "z"], ["a", "b", "z"], ["a", "c", "d", "z"]);
    expect(result.text).toBe(lines("a", ...block([], ["c", "d"]), "z"));
  });

  it("split a file both sides added, and keep CRLF", () => {
    const yours = lines("# Notes", "", "Ours.", "", "## Shared section", "One.", "Two.", "Three.", "Four.");
    const theirs = lines("# Notes", "", "Theirs.", "", "## Shared section", "One.", "Two.", "Three.", "Four.");
    const crlf = (text: string) => text.replace(/\n/g, "\r\n");
    const [action] = planMerge(files({}), files({ "NOTES.md": theirs }), files({ "NOTES.md": crlf(yours) }));
    expect(action?.kind).toBe("conflict");
    expect(action?.kind === "conflict" && action.content.toString()).toBe(
      crlf(lines("# Notes", "", ...block(["Ours."], ["Theirs."]), "", "## Shared section", "One.", "Two.", "Three.", "Four.")),
    );
  });
});
