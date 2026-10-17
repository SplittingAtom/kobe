import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE } from "./tests/support/constants.js";

/**
 * Browser suite for the chat surfaces (v1.1 Phase A/B), run against a deployment: never in CI.
 * The deployment and the account come from the environment only (the repository is public):
 * KOBE_BASE_URL, KOBE_USER, KOBE_PW. See README.md.
 */
const baseURL = process.env["KOBE_BASE_URL"];
if (!baseURL) throw new Error("KOBE_BASE_URL is required (the deployment's https URL)");

/** A test talks to real models: generous, and the compaction spec raises it further. */
const TEST_TIMEOUT_MS = 10 * 60_000;

/** The OS says light; the theme spec switches to dark itself. */
const browserUse = {
  colorScheme: "light",
  viewport: { width: 1280, height: 800 },
} as const;

export default defineConfig({
  testDir: "./tests",
  timeout: TEST_TIMEOUT_MS,
  expect: { timeout: 15_000 },
  // Every spec spends model tokens and starts a sandbox: one at a time unless asked otherwise.
  workers: Number(process.env["KOBE_WORKERS"] ?? 1),
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  // Screenshot baselines (consoles.spec.ts, KOBE-294): deployment data, so outside git. Per
  // platform: fonts render differently on macOS and in the Linux container.
  snapshotPathTemplate: "{testDir}/../console-shots/{platform}/{arg}{ext}",
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ["json", { outputFile: "test-results/results.json" }],
  ],
  use: {
    baseURL,
    ...browserUse,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      testMatch: /\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], ...browserUse, storageState: STORAGE_STATE },
    },
  ],
});
