import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE } from "./tests/support/constants.js";

/**
 * The web measurement run (KOBE-525): `npm run perf:measure` against a deployment, on demand only
 * (not part of the browser suite or CI). Same environment as the suite: KOBE_BASE_URL, KOBE_USER,
 * KOBE_PW (signed in once by tests/auth.setup.ts), KOBE_BROWSER_MAP; plus the KOBE_PERF_*
 * variables in perf/measure.perf.ts.
 */
const baseURL = process.env["KOBE_BASE_URL"];
if (!baseURL) throw new Error("KOBE_BASE_URL is required (the deployment's https URL)");

const map = process.env["KOBE_BROWSER_MAP"];
const launchOptions = map
  ? { args: [`--host-resolver-rules=MAP ${new URL(baseURL).hostname} ${map}`] }
  : {};
const browserUse = {
  colorScheme: "light",
  viewport: { width: 1280, height: 800 },
  launchOptions,
} as const;

export default defineConfig({
  testDir: ".",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL, ...browserUse, navigationTimeout: 45_000 },
  projects: [
    { name: "setup", testMatch: /tests\/auth\.setup\.ts/ },
    {
      name: "perf",
      testMatch: /perf\/.*\.perf\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], ...browserUse, storageState: STORAGE_STATE },
    },
  ],
});
