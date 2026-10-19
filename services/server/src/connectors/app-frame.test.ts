import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { APP_FRAME_CSP, WEBRTC_GUARD, appFrameDocument, withWebRtcGuard } from "./app-frame.js";

/** KOBE-437 review MEDIUM-2: WebRTC is blocked where browsers support it, and removed first. */
const BOM = String.fromCharCode(0xfeff);
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const directives = new Map(
  APP_FRAME_CSP.split(";").map((d) => {
    const [name = "", ...values] = d.trim().split(/\s+/);
    return [name, values.join(" ")] as const;
  }),
);

describe("app frame CSP", () => {
  it("sandboxes with scripts only, and blocks WebRTC, child frames and workers", () => {
    expect(directives.get("sandbox")).toBe("allow-scripts");
    expect(directives.get("webrtc")).toBe("'block'");
    expect(directives.get("frame-src")).toBe("'none'");
    expect(directives.get("child-src")).toBe("'none'");
    expect(directives.get("worker-src")).toBe("'none'");
    expect(directives.get("connect-src")).toBe("'none'");
  });
});

describe("withWebRtcGuard", () => {
  it("runs before anything in the template, after its doctype", () => {
    expect(withWebRtcGuard("<!DOCTYPE html>\n<html><script>x()</script>")).toBe(
      `<!DOCTYPE html>${WEBRTC_GUARD}\n<html><script>x()</script>`,
    );
    expect(withWebRtcGuard(`${BOM}  <!doctype html ><p>a</p>`)).toBe(
      `${BOM}  <!doctype html >${WEBRTC_GUARD}<p>a</p>`,
    );
    expect(withWebRtcGuard("<p>no doctype</p>")).toBe(`${WEBRTC_GUARD}<p>no doctype</p>`);
    // Comments before the doctype: still after the doctype (standards mode kept).
    expect(withWebRtcGuard("<!-- c --> <!doctype html><p>")).toBe(
      `<!-- c --> <!doctype html>${WEBRTC_GUARD}<p>`,
    );
  });

  it("removes the peer connection and data channel constructors", () => {
    for (const name of [
      "RTCPeerConnection",
      "webkitRTCPeerConnection",
      "mozRTCPeerConnection",
      "RTCDataChannel",
    ]) {
      expect(WEBRTC_GUARD).toContain(`"${name}"`);
    }
    expect(WEBRTC_GUARD.startsWith("<script>")).toBe(true);
    expect(WEBRTC_GUARD.endsWith("</script>")).toBe(true);
    expect(WEBRTC_GUARD.split("</script").length).toBe(2);
  });

  it("checks the stored bytes' hash, then serves them guarded", async () => {
    const html = "<!doctype html><p>t</p>";
    expect(appFrameDocument(html, sha("other"))).toBe("stale");
    const res = appFrameDocument(html, sha(html));
    if (res === "stale") throw new Error("expected a document");
    expect(await res.text()).toBe(withWebRtcGuard(html));
    expect(res.headers.get("content-security-policy")).toBe(APP_FRAME_CSP);
  });
});
