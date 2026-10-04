import { expect, test } from "bun:test";
import { parseRecipe } from "../../src/modules/models/recipes/recipe-serializer";

const base = {
  id: "r",
  name: "R",
  model_path: "/models/m.gguf",
  backend: "llamacpp",
  runtime: { kind: "docker", ref: "img" },
};

test("a key the schema does not recognise is folded into extra_args", () => {
  const recipe = parseRecipe({ ...base, someRetiredField: "x" });
  expect(recipe.extra_args).toEqual({ someRetiredField: "x" });
});

test("a recognised key stays a typed field and never becomes an extra arg", () => {
  const recipe = parseRecipe({ ...base, kv_cache_dtype: "fp8" });
  expect(recipe.extra_args).toEqual({});
  expect(recipe.kv_cache_dtype).toBe("fp8");
});

test("a retired field is dropped, not forwarded as an engine flag", () => {
  const recipe = parseRecipe({ ...base, thinking_mode: "conservative" });
  expect(recipe.extra_args).toEqual({});
  expect("thinking_mode" in recipe).toBe(false);
});

test("retiring a field never turns it into a flag the way an unknown key does", () => {
  const retired = parseRecipe({ ...base, thinking_mode: "conservative" });
  const unknown = parseRecipe({ ...base, some_unknown_key: "conservative" });
  expect(retired.extra_args).toEqual({});
  expect(unknown.extra_args).toEqual({ some_unknown_key: "conservative" });
});

const DISTINCTIVE_VALUES: Record<string, unknown> = {
  vision: true,
  env_vars: { SOME_VAR: "1" },
  tensor_parallel_size: 4,
  pipeline_parallel_size: 2,
  max_model_len: 4096,
  gpu_memory_utilization: 0.42,
  kv_cache_dtype: "fp8",
  max_num_seqs: 12,
  trust_remote_code: true,
  tool_call_parser: "qwen3_xml",
  reasoning_parser: "deepseek_r1",
  enable_auto_tool_choice: true,
  quantization: "awq",
  dtype: "bf16",
  host: "10.0.0.5",
  port: 9999,
  served_model_name: "distinctive-name",
  python_path: "/usr/bin/python",
  extra_args: { "some-extra-flag": true },
  max_thinking_tokens: 512,
};

test("every typed field with a real value stays typed and is never forwarded", () => {
  const recipe = parseRecipe({ ...base, ...DISTINCTIVE_VALUES });
  const extraKeys = Object.keys(recipe.extra_args ?? {});
  for (const field of Object.keys(DISTINCTIVE_VALUES)) {
    expect(extraKeys.includes(field)).toBe(false);
  }
});

test("an unrecognised field name is folded, so a rename is never silently dropped", () => {
  const recipe = parseRecipe({ ...base, think_mode: "aggressive" });
  expect(recipe.extra_args).toEqual({ think_mode: "aggressive" });
});

test("an explicit extra arg is preserved verbatim for the launcher to serialise", () => {
  const recipe = parseRecipe({ ...base, extra_args: { "flash-attn": true, mlock: false } });
  expect(recipe.extra_args).toEqual({ "flash-attn": true, mlock: false });
});

test("extra_args overrides a typed field of the same name rather than being dropped", () => {
  const recipe = parseRecipe({
    ...base,
    max_model_len: 8192,
    extra_args: { max_model_len: 65536 },
  });
  expect(recipe.max_model_len).toBe(8192);
  expect(recipe.extra_args).toEqual({ max_model_len: 65536 });
});

test("a retitled field is treated as a new one and folded, not silently dropped", () => {
  const recipe = parseRecipe({ ...base, think_mode: "conservative" });
  expect(recipe.extra_args).toEqual({ think_mode: "conservative" });
});