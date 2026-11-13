import { describe, expect, it } from "vitest";
import { ManifestError, parseTemplateManifest, readTemplateManifest } from "../src/core/manifest.js";
import { ModuleError } from "../src/core/plan.js";
import { belowStableWarning, choicesBelowStable, deprecationNotes, newChoices, refuseUnoffered } from "../src/core/support.js";
import { upgradedModules } from "../src/modify.js";
import { appStarterFiles, modulesManifest, temporaryDirectory, writeFiles } from "./helpers.js";

// A Starter that grades its options: Supabase Storage is in beta, and a deprecated Magic Link
// sign-in points to Supabase Auth.
const auth = modulesManifest.modules.auth;
const storage = modulesManifest.modules.storage;
const magicLink = {
  name: "Magic Link",
  status: "deprecated",
  since: "v0.40.0",
  replacement: "supabase",
  note: "Its provider stopped development.",
};
const graded = (link: Record<string, unknown> = magicLink) => ({
  ...modulesManifest,
  modules: {
    auth: { ...auth, options: { supabase: { ...auth.options.supabase, status: "stable" }, "magic-link": link, none: auth.options.none } },
    storage: {
      ...storage,
      options: {
        ...storage.options,
        s3: { ...storage.options.s3, status: "stable" },
        supabase: { ...storage.options.supabase, status: "beta", note: "No round trip in CI yet." },
      },
    },
  },
});
const manifest = parseTemplateManifest(JSON.stringify(graded()));
const project = (modules: Record<string, string>) => ({ modules, stacks: {} }) as unknown as Parameters<typeof upgradedModules>[1];

describe("support levels", () => {
  it("reads each option's level, and none from a Starter that grades nothing", () => {
    expect(manifest.modules.storage!.options.supabase!.support).toEqual({ level: "beta", note: "No round trip in CI yet.", offered: true });
    expect(manifest.modules.auth!.options["magic-link"]!.support).toEqual({
      level: "deprecated",
      note: "Its provider stopped development.",
      since: "v0.40.0",
      replacement: "supabase",
      offered: true,
    });
    expect(manifest.modules.storage!.options.none!.support).toBeUndefined();
    expect(parseTemplateManifest(JSON.stringify(modulesManifest)).modules.storage!.options.supabase!.support).toBeUndefined();
  });

  it("reads a level it does not know as experimental, and refuses a malformed one", () => {
    const newer = parseTemplateManifest(JSON.stringify(graded({ name: "Magic Link", status: "maintenance" })));
    expect(newer.modules.auth!.options["magic-link"]!.support?.level).toBe("experimental");
    expect(() => parseTemplateManifest(JSON.stringify(graded({ ...magicLink, offered: "no" })))).toThrow(ManifestError);
    expect(() => parseTemplateManifest(JSON.stringify(graded({ ...magicLink, note: 3 })))).toThrow(ManifestError);
  });

  it("reads a stack's level from its pack", async () => {
    const files = appStarterFiles();
    const expo = JSON.parse(files["apps/expo/clubedge.stack.json"]!);
    files["apps/expo/clubedge.stack.json"] = JSON.stringify({ ...expo, status: "beta", note: "No device in CI." });
    const starter = await temporaryDirectory();
    await writeFiles(starter, files);
    const read = await readTemplateManifest(starter);
    expect(read.stacks.expo!.support).toEqual({ level: "beta", note: "No device in CI.", offered: true });
    expect(read.stacks.next!.support).toBeUndefined();
  });

  it("warns about the choices below stable, and on add only about the ones it changes", () => {
    const choices = choicesBelowStable(manifest, { framework: "next" }, { auth: "supabase", storage: "supabase" });
    expect(choices.map(({ part, id }) => `${part}=${id}`)).toEqual(["storage=supabase"]);
    expect(belowStableWarning(manifest, choices, "flag", "https://github.com/Clubedge/clubedge-starter/blob/v0.32.0/STABILITY.md")).toBe(
      "This choice is not Stable yet (levels: https://github.com/Clubedge/clubedge-starter/blob/v0.32.0/STABILITY.md):\n" +
        "• Beta: Supabase Storage (--storage supabase). No round trip in CI yet.",
    );
    const before = { stacks: { framework: "next" }, modules: { auth: "supabase", storage: "supabase" } };
    expect(choicesBelowStable(manifest, { framework: "next" }, { auth: "none", storage: "supabase" }, before)).toEqual([]);
    expect(belowStableWarning(manifest, [], "argument", undefined)).toBeUndefined();
  });

  it("names the replacement of a deprecated choice, and refuses one no longer offered", () => {
    const deprecated = choicesBelowStable(manifest, {}, { auth: "magic-link", storage: "s3" });
    expect(() => refuseUnoffered(manifest, deprecated, "flag")).not.toThrow();
    expect(belowStableWarning(manifest, deprecated, "argument", undefined)).toBe(
      "This choice is not Stable yet:\n" +
        "• Deprecated since v0.40.0: Magic Link (auth magic-link). Use Supabase Auth (auth supabase) instead. Its provider stopped development.",
    );

    const retired = parseTemplateManifest(JSON.stringify(graded({ ...magicLink, offered: false })));
    const choices = choicesBelowStable(retired, {}, { auth: "magic-link", storage: "s3" });
    expect(() => refuseUnoffered(retired, choices, "flag")).toThrow(ModuleError);
    expect(() => refuseUnoffered(retired, choices, "flag")).toThrow(
      "Magic Link (--auth magic-link) is no longer offered to new projects. It was deprecated in v0.40.0. Choose Supabase Auth (--auth supabase) instead.",
    );
  });

  it("refuses an option no longer offered at any level, and only as a new choice", () => {
    // A stable option a Starter stopped offering, without deprecating it first.
    const stableRetired = graded();
    stableRetired.modules.storage.options.s3 = { ...stableRetired.modules.storage.options.s3, offered: false } as never;
    const retired = parseTemplateManifest(JSON.stringify(stableRetired));
    const chosen = { auth: "supabase", storage: "s3" };
    expect(choicesBelowStable(retired, {}, chosen)).toEqual([]);
    expect(() => refuseUnoffered(retired, newChoices(retired, {}, chosen), "argument")).toThrow(
      "S3-compatible (storage s3) is no longer offered to new projects.",
    );
    // A project that has it already keeps it while it changes something else.
    const before = { stacks: {}, modules: { auth: "none", storage: "s3" } };
    expect(newChoices(retired, {}, chosen, before).map((choice) => choice.id)).toEqual(["supabase"]);
  });

  it("reminds an upgraded project of a deprecated option, with the command that switches", () => {
    expect(deprecationNotes(manifest, {}, { auth: "magic-link", storage: "s3" }, "pnpm clubedge")).toEqual([
      "Magic Link (auth magic-link) is deprecated since Starter v0.40.0. It keeps working and upgrading for now. " +
        "Switch to Supabase Auth with: pnpm clubedge add auth supabase Its provider stopped development.",
    ]);
    expect(deprecationNotes(manifest, {}, { auth: "supabase", storage: "supabase" }, "pnpm clubedge")).toEqual([]);
  });

  it("stops an upgrade that would drop a removed option, naming what replaces it", () => {
    const removed = parseTemplateManifest(
      JSON.stringify({ ...modulesManifest, modules: { ...modulesManifest.modules, auth: { ...auth, removed: { "magic-link": { since: "v0.45.0", replacement: "supabase" } } } } }),
    );
    expect(removed.modules.auth!.removed).toEqual({ "magic-link": { since: "v0.45.0", replacement: "supabase" } });
    expect(() => upgradedModules(removed, project({ auth: "magic-link", storage: "s3" }))).toThrow(
      'The new Starter no longer offers Authentication "magic-link" (removed in v0.45.0). Switch to Supabase Auth with pnpm clubedge add auth supabase before upgrading: it changes the project on its own Starter release.',
    );
  });
});
