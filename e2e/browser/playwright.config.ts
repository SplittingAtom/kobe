import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE } from "./tests/support/constants.js";

/**
 * Browser suite for the chat surfaces (v1.1 Phase A/B), run against a deployment; in CI only as
 * Gate 5 (e2e/gate5.sh, KOBE-227) against k3d.
 * The deployment and the account come from the environment only (the repository is public):
 * KOBE_BASE_URL, KOBE_USER, KOBE_PW. See README.md.
 */
const baseURL = process.env["KOBE_BASE_URL"];
if (!baseURL) throw new Error("KOBE_BASE_URL is required (the deployment's https URL)");

/**
 * KOBE_BROWSER_MAP=host:port: Chromium connects there for the base URL's host (a port-forward to a
 * k3d ingress, e2e/gate5.sh), so the pages keep the deployment's own origin.
 */
const map = process.env["KOBE_BROWSER_MAP"];
/**
 * KOBE_SSO_MOCK_MAP=ip:port (KOBE-634, sso.spec.ts): Chromium reaches the mock identity provider's
 * in-cluster name (the host of KOBE_SSO_MOCK_ISSUER) through the cluster's ingress, so the
 * provider keeps one issuer for the server and the browser (e2e/sso/gate1-mock-idp.sh).
 */
const ssoMap = process.env["KOBE_SSO_MOCK_MAP"];
const ssoIssuer = process.env["KOBE_SSO_MOCK_ISSUER"];
const resolverRules = [
  ...(map ? [`MAP ${new URL(baseURL).hostname} ${map}`] : []),
  ...(ssoMap && ssoIssuer ? [`MAP ${new URL(ssoIssuer).hostname} ${ssoMap}`] : []),
];
const launchOptions = resolverRules.length
  ? { args: [`--host-resolver-rules=${resolverRules.join(",")}`] }
  : {};

/** A test talks to real models: generous, and the compaction spec raises it further. */
const TEST_TIMEOUT_MS = 10 * 60_000;

/** The OS says light; the theme spec switches to dark itself. */
const browserUse = {
  colorScheme: "light",
  viewport: { width: 1280, height: 800 },
  launchOptions,
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
    ["json", { outputFile: process.env["KOBE_BROWSER_RESULTS"] ?? "test-results/results.json" }],
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
    // KOBE_ALL_BROWSERS=1: the MCP App frame spec also in Firefox and WebKit, to record what each
    // does with WebRTC (KOBE-437 review MEDIUM-2); the Lakehouse Picker drop (KOBE-551) and the
    // pointer drag from the picker frame (KOBE-553) also in Firefox. Chromium stays the default project.
    ...(process.env["KOBE_ALL_BROWSERS"] === "1"
      ? (["firefox", "webkit"] as const).map((name) => ({
          name,
          testMatch:
            name === "firefox"
              ? /(app-frame|lakehouse-drop|frame-drag)\.spec\.ts/
              : /app-frame\.spec\.ts/,
          dependencies: ["setup"],
          use: {
            ...devices[name === "firefox" ? "Desktop Firefox" : "Desktop Safari"],
            ...browserUse,
            launchOptions: {},
            storageState: STORAGE_STATE,
          },
        }))
      : []),
  ],
});
