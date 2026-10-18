// Gate 3 (KOBE-231) browser checks, run by e2e/gate3.sh (or by hand) in a real Chromium against a
// deployment: what only a browser can show. Prints key=value lines for gate3.sh to assert on.
//
//   ac-5  the HTML chart artifact renders in the frame the chat embeds (same-origin <iframe> of
//         /v1/artifacts/:id/versions/:n/frame): its inline script runs, its origin is opaque, and
//         its fetch() to an outside address is blocked by the CSP (the violation is reported and no
//         request leaves the page; a request that did leave would be answered by the route below).
//   ac-4  the thread with the `remember` call shows the "Memory updated" chip with Undo.
//   ac-1  a thread pinned to an older agent version shows "v<N> available" with a switch; one
//         click moves the thread to v<N> (gate3.sh then checks that its next run uses it).
//
// Environment (no secrets on the command line): KOBE_BROWSER_BASE (the public URL), optional
// KOBE_BROWSER_MAP (host:port the browser connects to for the base's host, e.g. a port-forward to
// the ingress), KOBE_BROWSER_EMAIL, KOBE_BROWSER_PASSWORD, KOBE_BROWSER_TEAM, and the targets
// KOBE_BROWSER_ARTIFACT (id:version), KOBE_BROWSER_MEMORY_THREAD, KOBE_BROWSER_PINNED_THREAD.
// Uses @playwright/test from e2e/browser (npm ci there, then `npx playwright install chromium`).
import { chromium } from "@playwright/test";

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
};
const out = (key, value) => console.log(`${key}=${value}`);
const BASE = env("KOBE_BROWSER_BASE").replace(/\/$/, "");
const MAP = process.env.KOBE_BROWSER_MAP ?? "";
const TEAM = env("KOBE_BROWSER_TEAM");
/** The artifact's script reports here; nothing may ever reach it (`.invalid` never resolves). */
const BEACON = "https://gate3-beacon.invalid/";
const SHELL_MS = 45_000;

async function signIn(page) {
  await page.goto(`${BASE}/sign-in`);
  await page.getByLabel("Email").fill(env("KOBE_BROWSER_EMAIL"));
  await page.getByLabel("Password").fill(env("KOBE_BROWSER_PASSWORD"));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: SHELL_MS });
  out("signin", "ok");
}

/** ac-5: the frame, embedded the way the chat embeds it (same-origin iframe of /frame). */
async function frameCheck(context, page) {
  const [id, version] = env("KOBE_BROWSER_ARTIFACT").split(":");
  let beaconHits = 0;
  await context.route(`${BEACON}**`, (route) => {
    beaconHits += 1;
    return route.fulfill({
      status: 200,
      headers: { "access-control-allow-origin": "*" },
      body: "x",
    });
  });
  let frameStatus = "-";
  page.on("response", (res) => {
    if (res.url().includes(`/v1/artifacts/${id}/versions/${version}/frame`))
      frameStatus = String(res.status());
  });
  // A same-origin page of the deployment to embed the frame in (the chat's own origin).
  await page.goto(`${BASE}/v1/setup`);
  const src = `/v1/artifacts/${id}/versions/${version}/frame?team=${TEAM}`;
  await page.evaluate((s) => {
    const f = document.createElement("iframe");
    f.src = s;
    f.id = "gate3-frame";
    document.body.appendChild(f);
  }, src);
  const frame = await (
    await page.waitForSelector("#gate3-frame", { timeout: SHELL_MS })
  ).contentFrame();
  await frame.waitForFunction(
    () => document.getElementById("fetch")?.textContent !== "pending",
    null,
    {
      timeout: 20_000,
    },
  );
  // The violation event may follow the fetch's rejection; give it a moment, then read.
  await frame
    .waitForFunction(() => document.getElementById("csp")?.textContent !== "none", null, {
      timeout: 5_000,
    })
    .catch(() => {});
  const seen = await frame.evaluate(() => ({
    scripts: document.getElementById("scripts")?.textContent ?? "-",
    fetch: document.getElementById("fetch")?.textContent ?? "-",
    csp: document.getElementById("csp")?.textContent ?? "-",
    bars: document.querySelectorAll("svg rect").length,
    origin: String(self.origin),
  }));
  out("frame_status", frameStatus);
  out("frame_scripts", seen.scripts);
  out("frame_bars", seen.bars);
  out("frame_fetch", seen.fetch);
  out("frame_csp_violation", seen.csp);
  out("frame_origin", seen.origin);
  out("beacon_hits", beaconHits);
}

/** ac-4: the "Memory updated" chip with Undo on the thread whose run called remember. */
async function memoryChip(page) {
  await page.goto(`${BASE}/?thread=${env("KOBE_BROWSER_MEMORY_THREAD")}`);
  const chip = page.getByText(/Memory updated/).first();
  const visible = await chip.waitFor({ timeout: SHELL_MS }).then(
    () => true,
    () => false,
  );
  out("memory_chip", visible ? "visible" : "absent");
  const undo = page.getByRole("button", { name: /Undo/ }).first();
  out("memory_undo", (await undo.count()) > 0 ? "present" : "absent");
}

/** ac-1: a thread pinned to an older version says a newer one is available and offers a switch. */
async function versionBadge(page) {
  await page.goto(`${BASE}/?thread=${env("KOBE_BROWSER_PINNED_THREAD")}`);
  await page.locator('[data-role="assistant"]').first().waitFor({ timeout: SHELL_MS });
  const badge = page.getByText(/v\d+ available/i).first();
  const visible = await badge.waitFor({ timeout: 10_000 }).then(
    () => true,
    () => false,
  );
  out("version_badge", visible ? `visible:${oneLine(await badge.textContent())}` : "absent");
  const switcher = page.getByRole("button", { name: /^Switch this thread to v\d+$/ }).first();
  out("version_switch", (await switcher.count()) > 0 ? "present" : "absent");
  if ((await switcher.count()) === 0) return;
  // One click (KOBE-420): the offer goes once the server moved the thread to that version.
  const target = (await switcher.getAttribute("aria-label"))?.match(/v(\d+)$/)?.[1] ?? "?";
  await switcher.click();
  const gone = await page
    .locator("[data-kobe-agent-version]")
    .waitFor({ state: "detached", timeout: 10_000 })
    .then(
      () => true,
      () => false,
    );
  out("version_switched", gone ? target : "no");
}

const oneLine = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();

async function main() {
  const host = new URL(BASE).host;
  const args = MAP ? [`--host-resolver-rules=MAP ${host} ${MAP}`] : [];
  const browser = await chromium.launch({ args });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript((team) => {
      try {
        localStorage.setItem("kobe.lastTeamId", team);
      } catch {
        // storage unavailable (an opaque-origin frame): nothing to set
      }
    }, TEAM);
    const page = await context.newPage();
    await signIn(page);
    for (const [name, check] of [
      ["frame", () => frameCheck(context, page)],
      ["memory", () => memoryChip(page)],
      ["badge", () => versionBadge(page)],
    ]) {
      try {
        await check();
      } catch (err) {
        out(`${name}_error`, oneLine(err instanceof Error ? err.message : err).slice(0, 300));
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`gate3 browser failed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
