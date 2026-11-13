// What the CLI says about how ready a project's choices are. The Starter grades each module
// option and stack from what its CI runs (STABILITY.md defines the levels); this turns those
// grades into warnings when a project chooses something below stable, refuses an option new
// projects can no longer choose, and reminds an upgraded project of what is deprecated.
import type { Selection } from "./customize.js";
import type { Support, TemplateManifest } from "./manifest.js";
import { runsServer } from "./manifest-fields.js";
import { ModuleError, NO_STACK } from "./plan.js";

/** A module option or a stack, with its grade. */
export interface GradedChoice {
  kind: "module" | "app";
  /** The module, or the app slot. */
  part: string;
  /** The option or the stack. */
  id: string;
  name: string;
  support: Support;
}

const levelNames: Record<Support["level"], string> = {
  stable: "Stable",
  beta: "Beta",
  experimental: "Experimental",
  deprecated: "Deprecated",
};

/** The stacks and options a scaffold plan settled on, keyed by slot and by module. */
export function planChoices(plan: {
  apps: Array<{ slot: string; id: string }>;
  modules: Array<{ id: string; option: string }>;
}): { stacks: Selection; modules: Selection } {
  return {
    stacks: Object.fromEntries(plan.apps.map(({ slot, id }) => [slot, id])),
    modules: Object.fromEntries(plan.modules.map(({ id, option }) => [id, option])),
  };
}

/** The hint a prompt shows next to a choice below stable, such as "beta". */
export function levelHint(support: Support | undefined): string | undefined {
  return support && support.level !== "stable" ? support.level : undefined;
}

/** Every graded choice the selection makes. Choices from a Starter that grades nothing are left out. */
function gradedChoices(manifest: TemplateManifest, stacks: Selection, modules: Selection): GradedChoice[] {
  const choices: GradedChoice[] = [];
  for (const [slot, id] of Object.entries(stacks)) {
    const stack = id === NO_STACK ? undefined : manifest.stacks[id];
    if (stack?.support) choices.push({ kind: "app", part: slot, id, name: stack.name, support: stack.support });
  }
  for (const [module, id] of Object.entries(modules)) {
    const option = manifest.modules[module]?.options[id];
    if (option?.support) choices.push({ kind: "module", part: module, id, name: option.name, support: option.support });
  }
  return choices;
}

/**
 * The graded choices the selection makes, or, with `before`, only those it changes: add checks
 * and warns about the option it switches to, not about the ones the project already had.
 */
export function newChoices(
  manifest: TemplateManifest,
  stacks: Selection,
  modules: Selection,
  before?: { stacks: Selection; modules: Selection },
): GradedChoice[] {
  return gradedChoices(manifest, stacks, modules).filter(
    (choice) => !before || (choice.kind === "app" ? before.stacks : before.modules)[choice.part] !== choice.id,
  );
}

/** The new choices below stable, which create and add warn about. */
export function choicesBelowStable(
  manifest: TemplateManifest,
  stacks: Selection,
  modules: Selection,
  before?: { stacks: Selection; modules: Selection },
): GradedChoice[] {
  return newChoices(manifest, stacks, modules, before).filter((choice) => choice.support.level !== "stable");
}

/** How a choice is written on the command line: `--auth appwrite` for create, `auth appwrite` for add. */
export type ChoiceSyntax = "flag" | "argument";

function written(choice: { part: string; id: string }, syntax: ChoiceSyntax) {
  return syntax === "flag" ? `--${choice.part} ${choice.id}` : `${choice.part} ${choice.id}`;
}

function replacementOf(manifest: TemplateManifest, choice: GradedChoice) {
  const id = choice.support.replacement;
  if (id === undefined) return undefined;
  const name = choice.kind === "module" ? manifest.modules[choice.part]?.options[id]?.name : manifest.stacks[id]?.name;
  return { id, name: name ?? id };
}

/**
 * Refuses a choice new projects can no longer make: an option whose descriptor says
 * `"offered": false`, at whatever level. Projects that already have it keep it, so callers pass
 * only new choices (newChoices).
 */
export function refuseUnoffered(manifest: TemplateManifest, choices: GradedChoice[], syntax: ChoiceSyntax): void {
  const refused = choices.find((choice) => !choice.support.offered);
  if (!refused) return;
  const since = refused.support.since ? ` It was deprecated in ${refused.support.since}.` : "";
  const replacement = replacementOf(manifest, refused);
  throw new ModuleError(
    `${refused.name} (${written(refused, syntax)}) is no longer offered to new projects.${since}` +
      (replacement ? ` Choose ${replacement.name} (${written({ part: refused.part, id: replacement.id }, syntax)}) instead.` : ""),
  );
}

/** One line per choice below stable, such as "Beta: Appwrite (--auth appwrite). Signs in ...". */
export function describeBelowStable(manifest: TemplateManifest, choices: GradedChoice[], syntax: ChoiceSyntax): string[] {
  return choices.map((choice) => {
    const { level, note, since } = choice.support;
    const replacement = level === "deprecated" ? replacementOf(manifest, choice) : undefined;
    return [
      `${levelNames[level]}${since && level === "deprecated" ? ` since ${since}` : ""}: ${choice.name} (${written(choice, syntax)}).`,
      ...(replacement ? [`Use ${replacement.name} (${written({ part: choice.part, id: replacement.id }, syntax)}) instead.`] : []),
      ...(note ? [note] : []),
    ].join(" ");
  });
}

/**
 * Where a Starter release explains its levels. A local checkout (`--template-dir`) has no
 * release on GitHub to link to.
 */
export function stabilityUrl(source: { kind: string; repository?: string; ref: string }): string | undefined {
  return source.kind !== "directory" && source.repository ? `https://github.com/${source.repository}/blob/${source.ref}/STABILITY.md` : undefined;
}

/** The warning create and add print for choices below stable, or undefined when there are none. */
export function belowStableWarning(
  manifest: TemplateManifest,
  choices: GradedChoice[],
  syntax: ChoiceSyntax,
  url: string | undefined,
): string | undefined {
  if (!choices.length) return undefined;
  const lines = describeBelowStable(manifest, choices, syntax);
  return [
    `${choices.length === 1 ? "This choice is" : "These choices are"} not Stable yet${url ? ` (levels: ${url})` : ""}:`,
    ...lines.map((line) => `• ${line}`),
  ].join("\n");
}

/**
 * Whether add can switch a choice: a module's option, or an app installed on devices. The
 * framework and the API are chosen when a project is created (appSlots in modify.ts).
 */
function switchable(manifest: TemplateManifest, choice: GradedChoice): boolean {
  if (choice.kind === "module") return true;
  const roles = manifest.slots[choice.part]?.roles ?? [];
  return roles.length > 0 && roles.every((role) => !runsServer(role));
}

/**
 * Upgrade notes for the deprecated options and stacks a project keeps: each one still works and
 * still upgrades, and names the command that switches to its replacement, or, for the framework
 * and the API, which add cannot change, what new projects use.
 */
export function deprecationNotes(manifest: TemplateManifest, stacks: Selection, modules: Selection, cli: string): string[] {
  return gradedChoices(manifest, stacks, modules)
    .filter((choice) => choice.support.level === "deprecated")
    .map((choice) => {
      const replacement = replacementOf(manifest, choice);
      const since = choice.support.since ? ` since Starter ${choice.support.since}` : "";
      return [
        `${choice.name} (${choice.part} ${choice.id}) is deprecated${since}. It keeps working and upgrading for now.`,
        ...(replacement
          ? [
              switchable(manifest, choice)
                ? `Switch to ${replacement.name} with: ${cli} add ${choice.part} ${replacement.id}`
                : `New projects use ${replacement.name} (--${choice.part} ${replacement.id}): add cannot change what a project was created with.`,
            ]
          : []),
        ...(choice.support.note ? [choice.support.note] : []),
      ].join(" ");
    });
}
