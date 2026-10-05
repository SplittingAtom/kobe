import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Paths for tests against the REAL pinned Pi (`@earendil-works/pi-coding-agent` 1.0.0 from
 * images/sandbox/pi). CI installs Pi with `npm ci --prefix images/sandbox/pi --omit=dev
 * --ignore-scripts`; locally those suites are skipped when Pi is not installed (or set
 * KOBE_TEST_PI_BIN).
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../..");
const PACKAGE = path.resolve(HERE, "../..");

export const PI_BIN =
  process.env.KOBE_TEST_PI_BIN ?? path.join(REPO, "images/sandbox/pi/node_modules/.bin/pi");
export const PI_AVAILABLE = existsSync(PI_BIN);

/**
 * kobe-policy as Pi loads it. In CI (which builds before testing) the compiled file the image ships;
 * locally the TypeScript source (Pi loads TS through jiti), so a stale dist/ cannot mislead.
 */
const DIST_EXTENSION = path.join(PACKAGE, "dist/kobe-policy/index.js");
const SOURCE_EXTENSION = path.join(PACKAGE, "src/kobe-policy/index.ts");
export const REAL_POLICY_EXTENSION =
  process.env.KOBE_TEST_POLICY_EXTENSION ??
  (process.env.CI === undefined ? SOURCE_EXTENSION : DIST_EXTENSION);
if (process.env.CI !== undefined && !existsSync(REAL_POLICY_EXTENSION)) {
  throw new Error(`kobe-policy is not built: ${REAL_POLICY_EXTENSION} (run pnpm build first)`);
}

/** kobe-tools (KOBE-128), same rule as kobe-policy. */
export const REAL_TOOLS_EXTENSION =
  process.env.KOBE_TEST_TOOLS_EXTENSION ??
  path.join(
    PACKAGE,
    process.env.CI === undefined ? "src/kobe-tools/index.ts" : "dist/kobe-tools/index.js",
  );

/** Test-only Pi extensions (scripted model, an input-mutating handler). */
export const FAUX_MODEL_EXTENSION = path.join(HERE, "pi-extensions/faux-model.mjs");
export const MUTATE_INPUT_EXTENSION = path.join(HERE, "pi-extensions/mutate-input.mjs");
export const SHORT_TIMEOUT_POLICY_EXTENSION = path.join(
  HERE,
  "pi-extensions/kobe-policy-short-timeout.ts",
);

/** A run.start message for the faux model: the steps it plays, one assistant message each. */
export function fauxScript(steps: readonly Record<string, unknown>[]): string {
  return `faux:${JSON.stringify(steps)}`;
}
