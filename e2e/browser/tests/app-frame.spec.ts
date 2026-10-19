import { expect, test, type Response } from "@playwright/test";
import { PROBE_HTML, PROBE_MESSAGE, REMOTE, type ProbeReport } from "./support/app-frame-probe.js";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { pageApi } from "./support/gate5.js";

/**
 * KOBE-437 ac-1 (spec T2, T3): from inside an MCP App's frame, fetch, XMLHttpRequest, WebSocket,
 * a remote image, a form post, window.open, top navigation and document.cookie all fail.
 *
 * The frame is Kobe's member frame route (`GET /v1/team/apps/:appId/frame`) for one of the
 * member's live apps, in an iframe with `sandbox="allow-scripts"` and no `allow`, as `AppFrame`
 * makes it. The deployment's real response is kept (status and headers: the CSP with `sandbox
 * allow-scripts` and `connect-src 'none'`, XFO, no-store), and only its body is replaced by a
 * hostile probe (`support/app-frame-probe.ts`), so no test connector has to be pinned. It needs
 * one app the member can open: `KOBE_APP_ID`, or the first of `GET /v1/team/apps` (gate1: the
 * Catalyst connector with the member's key; k3d: the fake MCP app of MA-8, KOBE-441). Without
 * one it skips. No tokens; it changes nothing.
 */
const FRAME_CSP_PARTS = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "connect-src 'none'",
  "img-src data: blob:",
  "form-action 'none'",
  "frame-ancestors 'self'",
];

interface App {
  readonly appId: string;
  readonly sha256: string;
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
      await route.fulfill({ response, body: PROBE_HTML });
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
  const report = await page.evaluate(
    ({ src, probe }) =>
      new Promise<unknown>((resolve, reject) => {
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts");
        frame.setAttribute("referrerpolicy", "no-referrer");
        frame.setAttribute("data-kobe-test", "app-frame");
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
    { src, probe: PROBE_MESSAGE },
  );
  const { results, violations, origin, eventOrigin } = report as ProbeReport & {
    eventOrigin: string;
  };

  // The real route answered with the sandboxing header CSP (spec T3).
  expect(frameHeaders["content-type"]).toBe("text/html; charset=utf-8");
  for (const part of FRAME_CSP_PARTS)
    expect(frameHeaders["content-security-policy"]).toContain(part);
  expect(frameHeaders["x-frame-options"]).toBe("SAMEORIGIN");

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

  // The form post and the top navigation went nowhere.
  await expect(page.locator("[data-kobe-test=app-frame]")).toBeAttached();
  await expect
    .poll(
      () =>
        page
          .frame({ url: /\/frame\?/ })
          ?.locator("#state")
          .textContent(),
      {
        timeout: 10_000,
      },
    )
    .toBe("probe done");
  await page.waitForTimeout(1_500);
  expect(page.url()).toBe(before);
  expect(popups).toEqual([]);
  expect(leaked).toEqual([]);
  context.off("response", watch);
});
