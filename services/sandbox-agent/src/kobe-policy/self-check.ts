import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Load-time checks on how Pi was started (Pi 1.0.0 `cli/args.js`, verified):
 *
 * - **kobe-policy is the last `-e/--extension`.** Pi runs `tool_call` handlers extension by
 *   extension in load order, and load order is the order of `-e` flags (`resource-loader.js`
 *   `loadFinalExtensionSet`); an extension's handlers added later (e.g. from `session_start`) still
 *   run in its own slot. So the last extension's handler is the last to see `event.input` and nobody
 *   can mutate it after kobe-policy has checked it. The agent appends kobe-policy last
 *   (`pi-launch.ts`); this catches a launch that does not.
 * - **`--no-extensions` is present**, so no extension is discovered from `$HOME`, the workspace or
 *   settings (those load before CLI paths and could otherwise slip in).
 *
 * Returns the problem, or undefined when the launch is as expected.
 */
export function findLaunchProblem(
  argv: readonly string[],
  ownPath: string,
  cwd: string,
): string | undefined {
  let noExtensions = false;
  const extensions: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "--no-extensions" || arg === "-ne") noExtensions = true;
    if ((arg === "--extension" || arg === "-e") && i + 1 < argv.length) {
      extensions.push(argv[i + 1] as string);
      i += 1;
    }
  }
  if (!noExtensions) return "Pi was started without --no-extensions";
  const last = extensions.at(-1);
  if (last === undefined || !samePath(path.resolve(cwd, last), ownPath)) {
    return "kobe-policy is not the last extension Pi loads";
  }
  return undefined;
}

function samePath(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}

function canonical(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}
