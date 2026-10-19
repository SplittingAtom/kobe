import { expect, test, type Page, type Response } from "@playwright/test";
import { PROBE_HTML, PROBE_MESSAGE, REMOTE, type ProbeReport } from "./support/app-frame-probe.js";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { pageApi } from "./support/gate5.js";

/**
 * KOBE-437 ac-1 (spec T2, T3): from inside an MCP App's frame, fetch, XMLHttpRequest, WebSocket,
 * a remote image, a form post, window.open, top navigation and document.cookie all fail; WebRTC
 * is recorded per browser (review MEDIUM-2).
 *
 * The frame is Kobe's member frame route (`GET /v1/team/apps/:appId/frame`) for one of the
 * member's live apps. The deployment's real response is kept (status, headers, and the WebRTC
 * guard script it puts first), and only the template after the guard is replaced by a hostile
 * probe (`support/app-frame-probe.ts`), so no test connector has to be pinned. The probe runs
 * twice: in an iframe with `sandbox="allow-scripts"` as `AppFrame` makes it, and in one with no
 * `sandbox` attribute, which proves the header's `sandbox` alone isolates it.
 *
 * It needs one app the member can open: `KOBE_APP_ID`, or the first of `GET /v1/team/apps`
 * (gate1: the Catalyst connector with the member's key; k3d: the fake MCP app of MA-8,
 * KOBE-441). Without one it skips, unless `KOBE_REQUIRE_APP=1` (the gate runs), when it fails.
 * No tokens; it changes nothing.
 */
interface App {
  readonly appId: string;
  readonly sha256: string;
}

/** A CSP header as directive → values. */
function parseCsp(header: string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of (header ?? "").split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out.set(name.toLowerCase(), values);
  }
  return out;
}

/** The guard script the frame route puts before the template (it removes RTCPeerConnection). */
const GUARD = /<script>[^]*?RTCPeerConnection[^]*?<\/script>/;

/** The probe, after the deployment's own guard (and doctype), as the route would serve it. */
function probeBody(realBody: string): string {
  const guard = GUARD.exec(realBody);
  expect(guard, "the frame document starts with Kobe's WebRTC guard").not.toBeNull();
  expect(realBody.indexOf(guard?.[0] ?? "")).toBeLessThan(
    realBody.search(/<(?!!doctype)[a-z]/i) + 1,
  );
  return PROBE_HTML.replace("<!doctype html>", `<!doctype html>${guard?.[0] ?? ""}`);
}

type Report = ProbeReport & { eventOrigin: string };

async function runProbe(page: Page, src: string, sandboxed: boolean): Promise<Report> {
  return (await page.evaluate(
    ({ src, probe, sandboxed }) =>
      new Promise<unknown>((resolve, reject) => {
        const frame = document.createElement("iframe");
        if (sandboxed) frame.setAttribute("sandbox", "allow-scripts");
        frame.setAttribute("referrerpolicy", "no-referrer");
        frame.setAttribute("data-kobe-test", sandboxed ? "app-frame" : "app-frame-header-only");
        frame.title = "app frame probe";
        frame.style.cssText = "position:fixed;right:0;bottom:0;width:320px;height:200px";
        const timer = setTimeout(() => reject(new Error("the probe never reported")), 30_000);
        window.addEventListener("message", (event) => {
          if (event.source !== frame.contentWindow) return;
          if ((event.data as { probe?: string })?.probe !== probe) return;
          clearTimeout(timer);
          resolve({ ...(event.data as object), eventOrigin: event.origin });
        });
        frame.src = src;
        document.body.appendChild(frame);
      }),
    { src, probe: PROBE_MESSAGE, sandboxed },
  )) as Report;
}

function expectIsolated(report: Report): void {
  const { results, violations, origin, eventOrigin } = report;
  // The script ran (inline scripts are allowed) in an opaque origin.
  expect(origin).toBe("null");
  expect(eventOrigin).toBe("null");
  // Network: refused by the policy, not merely unreachable.
  expect(results["fetch_remote"]).toMatch(/^threw:/);
  expect(results["fetch_kobe"]).toMatch(/^threw:/);
  expect(results["xhr"]).toBe("error");
  expect(results["websocket"]).not.toBe("reached");
  expect(results["img"]).toBe("error");
  const blocked = (directive: string, path: string) =>
    violations.some((v) => v.directive === directive && v.blocked.includes(path));
  expect(blocked("connect-src", "/fetch")).toBe(true);
  expect(blocked("connect-src", "/v1/team/apps")).toBe(true);
  expect(blocked("connect-src", "/xhr")).toBe(true);
  expect(blocked("connect-src", "/ws")).toBe(true);
  expect(blocked("img-src", "/img.png")).toBe(true);
  // No popup, no cookies or storage, no access to Kobe's page.
  expect(results["window_open"]).toBe("null");
  expect(results["cookie"]).toMatch(/^threw:SecurityError/);
  expect(results["local_storage"]).toMatch(/^threw:SecurityError/);
  expect(results["parent_dom"]).toMatch(/^threw:SecurityError/);
  // WebRTC: the guard removed the constructor in the frame's own realm. A fresh realm is the
  // accepted residual (spec §3); it is recorded, not asserted.
  expect(JSON.parse(results["webrtc"] ?? "{}")).toEqual({ constructor: "absent" });
}

test("an app frame cannot reach the network, Kobe or the page around it (KOBE-437 ac-1)", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  const listed = await pageApi<{ apps?: App[] }>(page, "GET", "/v1/team/apps");
  expect(listed.status).toBe(200);
  const wanted = process.env["KOBE_APP_ID"];
  const app = (listed.json.apps ?? []).find((a) => wanted === undefined || a.appId === wanted);
  if (process.env["KOBE_REQUIRE_APP"] === "1") {
    expect(app, "KOBE_REQUIRE_APP=1: the member needs a live MCP App").toBeDefined();
  }
  test.skip(app === undefined, "No MCP App is live for this member in the active team.");
  if (!app) return;
  const team = await page.evaluate(() => window.localStorage.getItem("kobe.lastTeamId"));
  expect(team).toBeTruthy();

  // The real frame response, with the probe in place of the template.
  let frameHeaders: Record<string, string> = {};
  const framePath = `/v1/team/apps/${app.appId}/frame`;
  await page.route(
    (url) => url.pathname === framePath,
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      frameHeaders = response.headers();
      await route.fulfill({ response, body: probeBody(await response.text()) });
    },
  );
  // Chromium reports a request the CSP blocked as a request that failed; a leak is a response.
  const leaked: string[] = [];
  const watch = (response: Response) => {
    if (response.url().startsWith(REMOTE)) leaked.push(response.url());
  };
  context.on("response", watch);
  const popups: string[] = [];
  context.on("page", (p) => popups.push(p.url()));
  const before = page.url();

  const src = `${framePath}?team=${team}&sha256=${app.sha256}`;
  const reports = {
    sandboxed: await runProbe(page, src, true),
    headerOnly: await runProbe(page, src, false),
  };

  // The real route answered with the sandboxing header CSP (spec T3), parsed, not matched.
  expect(frameHeaders["content-type"]).toBe("text/html; charset=utf-8");
  expect(frameHeaders["x-frame-options"]).toBe("SAMEORIGIN");
  const csp = parseCsp(frameHeaders["content-security-policy"]);
  expect(csp.get("sandbox")).toEqual(["allow-scripts"]);
  expect(frameHeaders["content-security-policy"]).not.toContain("allow-same-origin");
  for (const [directive, value] of [
    ["default-src", "'none'"],
    ["connect-src", "'none'"],
    ["frame-src", "'none'"],
    ["child-src", "'none'"],
    ["worker-src", "'none'"],
    ["form-action", "'none'"],
    ["webrtc", "'block'"],
  ] as const) {
    expect(csp.get(directive), directive).toEqual([value]);
  }
  expect(csp.get("img-src")).toEqual(["data:", "blob:"]);
  expect(csp.get("frame-ancestors")).toEqual(["'self'"]);

  // Both frames are isolated: the attribute's sandbox and the header's alone.
  expectIsolated(reports.sandboxed);
  expectIsolated(reports.headerOnly);
  const webrtc = Object.fromEntries(
    Object.entries(reports).map(([k, r]) => [
      k,
      { main: r.results["webrtc"], freshRealm: r.results["webrtc_fresh_realm"] },
    ]),
  );
  test.info().annotations.push({ type: "webrtc", description: JSON.stringify(webrtc) });
  console.log(`webrtc (${test.info().project.name}): ${JSON.stringify(webrtc)}`);

  // The form post and the top navigation went nowhere.
  await expect(page.locator("[data-kobe-test=app-frame]")).toBeAttached();
  await expect(page.locator("[data-kobe-test=app-frame-header-only]")).toBeAttached();
  await expect
    .poll(() => page.frames().filter((f) => /\/frame\?/.test(f.url())), {
      timeout: 10_000,
    })
    .toHaveLength(2);
  for (const frame of page.frames().filter((f) => /\/frame\?/.test(f.url()))) {
    await expect(frame.locator("#state")).toHaveText("probe done", { timeout: 10_000 });
  }
  await page.waitForTimeout(1_500);
  expect(page.url()).toBe(before);
  expect(popups).toEqual([]);
  expect(leaked).toEqual([]);
  context.off("response", watch);
});
