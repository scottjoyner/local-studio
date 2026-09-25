import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

const SECRET_ENV_NAMES = new Set([
  "OPENROUTER_API_KEY",
  "TYPESAFE_API_KEY",
]);

export function sanitizedPythonEnvironment(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value == null) continue;
    const upper = key.toUpperCase();
    if (
      upper.startsWith("PYTHON") ||
      upper.startsWith("LD_") ||
      upper.startsWith("DYLD_") ||
      SECRET_ENV_NAMES.has(upper)
    ) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

export function isolatedPythonModuleInvocation({
  python,
  repoRoot,
  module,
  argv,
}) {
  if (!python || !repoRoot || !module || !Array.isArray(argv)) {
    throw new Error("Invalid isolated Python module invocation");
  }
  const sourceRoot = join(repoRoot, "src");
  const pythonArgv = [module, ...argv];
  const bootstrap = [
    "import runpy,sys",
    `sys.path.insert(0, ${JSON.stringify(sourceRoot)})`,
    `sys.argv=${JSON.stringify(pythonArgv)}`,
    `runpy.run_module(${JSON.stringify(module)},run_name="__main__")`,
  ].join(";");

  return {
    command: python,
    args: ["-I", "-c", bootstrap],
    env: sanitizedPythonEnvironment(),
  };
}

export function runIsolatedPythonModule({
  python,
  repoRoot,
  module,
  argv,
  cwd = repoRoot,
}) {
  const invocation = isolatedPythonModuleInvocation({
    python,
    repoRoot,
    module,
    argv,
  });
  return spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    env: invocation.env,
  });
}

export function requireAbsolutePythonForTrustedProducer(
  python,
  label,
) {
  if (!isAbsolute(python)) {
    throw new Error(
      `${label} must be an absolute Python executable path for trusted producer evidence`,
    );
  }
  return python;
}
