/**
 * Pure helpers for the launch-command preview.
 *
 * Kept free of React so the controller test suite can exercise the rules directly — the
 * frontend has no test runner, and the rule that matters most here is a correctness rule about
 * when a stale answer may be shown, not a rendering detail.
 */

/** Matches the separator the local command builder uses, so the two render comparably. */
export const PREVIEW_SEPARATOR = " \\\n  ";

export const renderPreviewCommand = (argv: readonly string[]): string =>
  argv.join(PREVIEW_SEPARATOR);

export interface LaunchPreviewAnswer<TRecipe> {
  /** The exact recipe object this answer was computed from. */
  forRecipe: TRecipe | null;
  command: string | null;
  warnings: string[];
  status: "idle" | "ready" | "unavailable";
}

export const emptyPreviewAnswer = <TRecipe>(): LaunchPreviewAnswer<TRecipe> => ({
  forRecipe: null,
  command: null,
  warnings: [],
  status: "idle",
});

/**
 * An answer may only be shown when it was computed from the recipe currently in the editor.
 *
 * Identity, not a status flag. Every draft edit produces a new recipe object, so an answer whose
 * `forRecipe` is not the current object was computed from a superseded draft. That distinction
 * matters because `handleCommandChange` persists `launch_command` on every keystroke by comparing
 * the typed text against the displayed command: a stale command offered as editable would let an
 * ordinary keystroke be recorded as an override.
 */
export const isPreviewCurrent = <TRecipe>(
  answer: LaunchPreviewAnswer<TRecipe>,
  recipe: TRecipe,
): boolean => answer.status === "ready" && answer.forRecipe === recipe;
