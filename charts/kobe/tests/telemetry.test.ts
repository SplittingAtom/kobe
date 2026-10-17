import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// Render tests for OpenTelemetry tracing values (KOBE-10).

const CHART_DIR = fileURLToPath(new URL("..", import.meta.url));
const HELM = process.env.HELM_BIN ?? "helm";
const BASE: Record<string, string> = {
  "ingress.host": "kobe.example.com",
  "postgres.external.existingSecret": "kobe-db",
  "s3.endpoint": "https://s3.example.com",
  "s3.bucket": "kobe",
  "s3.existingSecret": "kobe-s3",
  "smtp.host": "smtp.example.com",
  "smtp.from": "Kobe <kobe@example.com>",
  "global.allowGeneratedSecretsOffline": "true",
};
const SERVICES = [
  "kobe-server",
  "kobe-scheduler",
  "kobe-mcp-proxy",
  "kobe-egress-proxy",
  "kobe-model-gateway",
];

type Manifest = { kind: string; metadata: { name: string }; [k: string]: any };

function render(values: Record<string, string> = {}): Manifest[] {
  const args = Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
  const out = execFileSync(HELM, ["template", "kobe", CHART_DIR, "-n", "kobe", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return parseAllDocuments(out)
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
}

const otelEnv = (ms: Manifest[], deployment: string) =>
  (
    (ms.find((m) => m.kind === "Deployment" && m.metadata.name === deployment)?.spec.template.spec
      .containers[0].env ?? []) as any[]
  ).filter((e) => e.name.startsWith("KOBE_OTEL_"));

describe("tracing values (KOBE-10)", () => {
  it("sets nothing by default (tracing off)", () => {
    const ms = render();
    for (const d of SERVICES) expect(otelEnv(ms, d), d).toEqual([]);
  });

  it("points every instrumented service at the endpoint, content capture off", () => {
    const ms = render({ "telemetry.endpoint": "http://otel:4318" });
    for (const d of SERVICES) {
      expect(otelEnv(ms, d), d).toEqual([
        { name: "KOBE_OTEL_ENDPOINT", value: "http://otel:4318" },
        { name: "KOBE_OTEL_CAPTURE_CONTENT", value: "false" },
      ]);
    }
  });

  it("opts in to content capture and reads headers from a Secret", () => {
    const ms = render({
      "telemetry.endpoint": "http://otel:4318",
      "telemetry.captureContent": "true",
      "telemetry.headersSecret": "otel-auth",
    });
    expect(otelEnv(ms, "kobe-model-gateway")).toEqual([
      { name: "KOBE_OTEL_ENDPOINT", value: "http://otel:4318" },
      { name: "KOBE_OTEL_CAPTURE_CONTENT", value: "true" },
      {
        name: "KOBE_OTEL_HEADERS",
        valueFrom: { secretKeyRef: { name: "otel-auth", key: "headers" } },
      },
    ]);
  });
});

describe("sandboxes hold no collector URL or credential (KOBE-274 ac-3)", () => {
  it("renders the endpoint and the headers Secret into the five services only", () => {
    const ms = render({
      "telemetry.endpoint": "http://otel-collector.example:4318",
      "telemetry.headersSecret": "otel-auth",
    });
    const holders = ms
      .filter((m) => /otel-collector\.example|otel-auth/.test(JSON.stringify(m)))
      .map((m) => `${m.kind}/${m.metadata.name}`)
      .sort();
    expect(holders).toEqual(SERVICES.map((d) => `Deployment/${d}`).sort());
    // Nothing the server hands to sandboxes (its sandbox config) names the collector.
    const server = ms.find((m) => m.kind === "Deployment" && m.metadata.name === "kobe-server");
    const sandboxConfig = (server?.spec.template.spec.containers[0].env as any[]).filter((e) =>
      /^KOBE_SANDBOX_/.test(e.name),
    );
    expect(JSON.stringify(sandboxConfig)).not.toMatch(/otel|4318/i);
  });
});
