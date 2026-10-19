/**
 * The hostile app document of the MCP Apps frame spec (KOBE-437 ac-1, `app-frame.spec.ts`). Its
 * inline script tries every way out of the frame, records each outcome and every CSP violation,
 * and posts the record to the parent (`postMessage` is the one channel an app has). It then tries
 * a form post and a top navigation, which the spec checks from outside (the page stays put and
 * no request leaves).
 *
 * `REMOTE` never needs to answer: a reached host would be a failure whatever it returns, and the
 * spec also requires a CSP violation per attempt, so a plain network failure does not pass.
 */
export const REMOTE = "https://example.com";
export const PROBE_MESSAGE = "kobe-app-frame-probe";

export const PROBE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>probe</title>
<style>body{font:14px sans-serif}</style></head>
<body><p id="state">probe running</p>
<script>
(async () => {
  const REMOTE = ${JSON.stringify(REMOTE)};
  const kobe = new URL(document.URL).origin;
  const violations = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    violations.push({ directive: e.effectiveDirective, blocked: String(e.blockedURI) });
  });
  const results = {};
  const settle = (fn, ms = 4000) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), ms);
      try {
        fn((v) => { clearTimeout(timer); resolve(v); });
      } catch (e) {
        clearTimeout(timer);
        resolve("threw:" + e.name);
      }
    });
  const attempt = async (name, fn) => {
    try { results[name] = await fn(); } catch (e) { results[name] = "threw:" + e.name; }
  };
  await attempt("fetch_remote", async () => { await fetch(REMOTE + "/fetch"); return "reached"; });
  await attempt("fetch_kobe", async () => { await fetch(kobe + "/v1/team/apps"); return "reached"; });
  await attempt("xhr", () => settle((done) => {
    const x = new XMLHttpRequest();
    x.onload = () => done("reached");
    x.onerror = () => done("error");
    x.open("GET", REMOTE + "/xhr");
    x.send();
  }));
  await attempt("websocket", () => settle((done) => {
    const ws = new WebSocket(REMOTE.replace("https", "wss") + "/ws");
    ws.onopen = () => done("reached");
    ws.onerror = () => done("error");
  }));
  await attempt("img", () => settle((done) => {
    const img = new Image();
    img.onload = () => done("reached");
    img.onerror = () => done("error");
    img.src = REMOTE + "/img.png";
    document.body.appendChild(img);
  }));
  await attempt("window_open", async () => (window.open(REMOTE + "/popup") === null ? "null" : "opened"));
  await attempt("cookie", async () => "read:" + document.cookie.length);
  await attempt("local_storage", async () => "read:" + window.localStorage.length);
  await attempt("parent_dom", async () => "read:" + window.parent.document.title.length);
  // WebRTC (review MEDIUM-2): connect-src does not govern it. Record what this browser does in
  // this realm (Kobe's guard should have removed the constructor) and in a fresh one.
  const rtc = (win) => new Promise((resolve) => {
    const Ctor = win.RTCPeerConnection || win.webkitRTCPeerConnection;
    if (typeof Ctor !== "function") return resolve({ constructor: "absent" });
    let pc;
    try {
      pc = new Ctor({ iceServers: [{ urls: "stun:" + new URL(REMOTE).hostname + ":3478" }] });
    } catch (e) {
      return resolve({ constructor: "present", create: "threw:" + e.name });
    }
    const types = [];
    pc.onicecandidate = (e) => { if (e.candidate) types.push(e.candidate.type || "unknown"); };
    const finish = (how) => { try { pc.close(); } catch (e) {} resolve({ constructor: "present", create: "ok", gathering: how, candidates: types }); };
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") finish("complete"); };
    try {
      pc.createDataChannel("probe");
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch((e) => finish("threw:" + e.name));
    } catch (e) {
      finish("threw:" + e.name);
    }
    setTimeout(() => finish("timeout"), 3000);
  });
  await attempt("webrtc", async () => JSON.stringify(await rtc(window)));
  await attempt("webrtc_fresh_realm", async () => {
    const child = document.createElement("iframe");
    document.body.appendChild(child);
    const win = child.contentWindow;
    if (!win) return JSON.stringify({ realm: "none" });
    return JSON.stringify({ realm: "about:blank", ...(await rtc(win)) });
  });
  // Let late violation reports arrive before reporting.
  await new Promise((r) => setTimeout(r, 300));
  parent.postMessage({ probe: ${JSON.stringify(PROBE_MESSAGE)}, origin: self.origin, results, violations }, "*");
  // Checked from outside: neither may leave the frame.
  const form = document.createElement("form");
  form.method = "post";
  form.action = REMOTE + "/form";
  form.target = "_top";
  const field = document.createElement("input");
  field.name = "q";
  field.value = "x";
  form.appendChild(field);
  document.body.appendChild(form);
  try { form.submit(); } catch (e) {}
  try { window.top.location.href = REMOTE + "/top"; } catch (e) {}
  document.getElementById("state").textContent = "probe done";
})();
</script></body></html>`;

/** What the probe posts. */
export interface ProbeReport {
  readonly probe: string;
  readonly origin: string;
  readonly results: Record<string, string>;
  readonly violations: { readonly directive: string; readonly blocked: string }[];
}
