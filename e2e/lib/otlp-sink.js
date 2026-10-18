// Minimal OTLP/HTTP trace sink for the k3d e2e suite (KOBE-274): Node built-ins only, no
// dependencies. POST /v1/traces takes OTLP JSON (what @opentelemetry/exporter-trace-otlp-http
// sends) and keeps the spans in memory (bounded); GET /spans?trace=<hex> lists one trace's spans
// flattened as {service, name, traceId, spanId, parentSpanId, attributes}. Test fixture only.
const http = require("http");
const MAX_SPANS = 50000;
let spans = [];

const hex = (id) => {
  if (typeof id !== "string" || id === "") return "";
  return /^[0-9a-f]+$/i.test(id) && (id.length === 32 || id.length === 16)
    ? id.toLowerCase()
    : Buffer.from(id, "base64").toString("hex");
};
const valueOf = (v) => {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("boolValue" in v) return v.boolValue;
  return JSON.stringify(v);
};
const attrs = (list) => Object.fromEntries((list || []).map((a) => [a.key, valueOf(a.value)]));

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://sink");
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200).end("ok");
      return;
    }
    if (req.method === "GET" && url.pathname === "/spans") {
      const trace = url.searchParams.get("trace");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(spans.filter((s) => !trace || s.traceId === trace)));
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/v1/traces") {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        for (const rs of body.resourceSpans || []) {
          const service = attrs(rs.resource && rs.resource.attributes)["service.name"];
          for (const ss of rs.scopeSpans || []) {
            for (const s of ss.spans || []) {
              spans.push({
                service,
                name: s.name,
                traceId: hex(s.traceId),
                spanId: hex(s.spanId),
                parentSpanId: hex(s.parentSpanId),
                attributes: attrs(s.attributes),
              });
            }
          }
        }
        if (spans.length > MAX_SPANS) spans = spans.slice(-MAX_SPANS);
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      } catch {
        res.writeHead(400).end();
      }
    });
  })
  .listen(4318);
