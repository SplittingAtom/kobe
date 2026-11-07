import http from "node:http";
import type { Route } from "@playwright/test";

/** The guard script Kobe's frame route puts before the template (it removes RTCPeerConnection). */
export const FRAME_GUARD = /<script>[^]*?RTCPeerConnection[^]*?<\/script>/;

/**
 * The deployment's real answer to an intercepted request. `route.fetch()` runs in Node, which
 * does not see Chromium's `--host-resolver-rules`: with `KOBE_BROWSER_MAP` (a k3d port-forward,
 * e2e/gate-apps.sh) the request goes to the mapped address with the site's own Host header, the
 * way Chromium sends it; otherwise `route.fetch()` as is.
 */
export async function fetchReal(
  route: Route,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const map = process.env["KOBE_BROWSER_MAP"];
  if (!map) {
    const response = await route.fetch();
    return { status: response.status(), headers: response.headers(), body: await response.text() };
  }
  const request = route.request();
  const url = new URL(request.url());
  const [host, port] = map.split(":");
  const headers = { ...(await request.allHeaders()), host: url.host };
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port: Number(port ?? 80),
        path: `${url.pathname}${url.search}`,
        method: request.method(),
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: out,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
