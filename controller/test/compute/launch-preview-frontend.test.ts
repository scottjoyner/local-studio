import { expect, test } from "bun:test";
import {
  PREVIEW_SEPARATOR,
  emptyPreviewAnswer,
  isPreviewCurrent,
  renderPreviewCommand,
  type LaunchPreviewAnswer,
} from "../../../frontend/src/features/recipes/launch-preview";

/**
 * The frontend has no test runner, so the preview's correctness rules are exercised from here.
 *
 * The rule that matters is `isPreviewCurrent`. `handleCommandChange` in the recipe modal persists
 * `launch_command` on every keystroke, comparing the typed text against the displayed command. If
 * a stale answer were treated as current, an ordinary keystroke would be recorded as an override
 * on a recipe the user never overrode.
 */

interface Draft {
  model_path: string;
  max_model_len: number;
}

const answerFor = <T,>(forRecipe: T, status: LaunchPreviewAnswer<T>["status"]): LaunchPreviewAnswer<T> => ({
  forRecipe,
  command: "llama-server --model /models/m",
  warnings: [],
  status,
});

test("an answer computed from the current draft is current", () => {
  const recipe: Draft = { model_path: "/models/m", max_model_len: 8192 };
  expect(isPreviewCurrent(answerFor(recipe, "ready"), recipe)).toBe(true);
});

test("an answer computed from a superseded draft is not current", () => {
  const edited: Draft = { model_path: "/models/m", max_model_len: 8192 };
  // Any edit produces a new object, even when the field values match.
  const superseded: Draft = { model_path: "/models/m", max_model_len: 8192 };
  expect(isPreviewCurrent(answerFor(superseded, "ready"), edited)).toBe(false);
});

test("a failed or idle answer is never current, even for the same recipe", () => {
  const recipe: Draft = { model_path: "/models/m", max_model_len: 8192 };
  expect(isPreviewCurrent(answerFor(recipe, "unavailable"), recipe)).toBe(false);
  expect(isPreviewCurrent(emptyPreviewAnswer<Draft>(), recipe)).toBe(false);
});

test("a stale answer with a ready status is still withheld", () => {
  // The exact race: the fetch for draft A is still in flight when the user edits to draft B, and
  // A's answer arrives afterwards. Status is "ready" but it describes a command for a recipe
  // that no longer exists in the editor.
  const recipe: Draft = { model_path: "/models/m", max_model_len: 8192 };
  const stale = answerFor<Draft>({ model_path: "/models/m", max_model_len: 4096 }, "ready");
  expect(stale.status).toBe("ready");
  expect(isPreviewCurrent(stale, recipe)).toBe(false);
});

test("preview renders argv with the same separator the local builder uses", () => {
  // Same separator, so a controller-rendered command and a locally-rendered one are visually
  // comparable and a user diffing them sees a flag difference rather than a formatting one.
  expect(renderPreviewCommand(["llama-server", "--port", "8000"])).toBe(
    ["llama-server", "--port", "8000"].join(PREVIEW_SEPARATOR),
  );
  expect(PREVIEW_SEPARATOR).toBe(" \\\n  ");
});

test("empty argv renders as an empty string rather than throwing", () => {
  expect(renderPreviewCommand([])).toBe("");
});

test("rendering the preview is lossless", () => {
  // The command string is only a rendering of argv; splitting it back must recover the tokens
  // exactly, because that string is what the modal compares against to decide whether a typed
  // value is an override. A lossy render would corrupt that comparison.
  const tokens = (rendered: string): string[] =>
    rendered
      .split(/\\\s*\n\s*/)
      .flatMap((part) => part.replace(/\\\s/g, " ").trim().split(/\s+/))
      .filter(Boolean);

  const argv = [
    "llama-server",
    "--model",
    "/models/m",
    "--host",
    "127.0.0.1",
    "--reasoning-format",
    "deepseek",
  ];
  expect(tokens(renderPreviewCommand(argv))).toEqual(argv);
});
