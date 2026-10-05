import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { loadConfig } from "../../../services/mcp-proxy/src/config.js";

// Render tests for the MCP proxy's chart pieces (KOBE-58): Deployment env, internal key, the
// server's internal listener, NetworkPolicies.

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

type Manifest = { kind: string; metadata: { name: string }; [k: string]: any };
type EnvVar = { name: string; value?: string; valueFrom?: any };

function render(
  values: Record<string, string> = {},
  json: Record<string, unknown> = {},
): Manifest[] {
  const args = [
    ...Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]),
    ...Object.entries(json).flatMap(([k, v]) => ["--set-json", `${k}=${JSON.stringify(v)}`]),
  ];
  const out = execFileSync(HELM, ["template", "kobe", CHART_DIR, "-n", "kobe", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return parseAllDocuments(out)
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
}

const find = (ms: Manifest[], kind: string, name: string) =>
  ms.find((m) => m.kind === kind && m.metadata.name === name);
const pod = (ms: Manifest[], name: string) => find(ms, "Deployment", name)?.spec.template.spec;
const envOf = (ms: Manifest[], name: string): EnvVar[] => pod(ms, name)?.containers[0].env ?? [];
const policy = (ms: Manifest[]) => find(ms, "NetworkPolicy", "kobe-mcp-proxy")?.spec;
const plain = (env: EnvVar[]) =>
  Object.fromEntries(env.filter((e) => e.value !== undefined).map((e) => [e.name, e.value]));

describe("MCP proxy Deployment", () => {
  const ms = render();

  it("gets only its own session key and the internal key; no database, no API token", () => {
    const env = envOf(ms, "kobe-mcp-proxy");
    const secrets = env.filter((e) => e.valueFrom).map((e) => [e.name, e.valueFrom.secretKeyRef]);
    expect(secrets).toEqual([
      ["KOBE_SESSION_KEY_MCP_PROXY", { name: "kobe-sandbox-session-keys", key: "mcp-proxy" }],
      ["KOBE_MCP_INTERNAL_KEY", { name: "kobe-mcp-proxy-internal", key: "key" }],
    ]);
    expect(env.some((e) => e.name.includes("DATABASE"))).toBe(false);
    expect(pod(ms, "kobe-mcp-proxy")?.automountServiceAccountToken).toBe(false);
    expect(pod(ms, "kobe-mcp-proxy")?.initContainers).toBeUndefined();
  });

  it("renders env the proxy's config schema accepts (HTTPS on 443, server's internal port)", () => {
    const config = loadConfig({
      ...plain(envOf(ms, "kobe-mcp-proxy")),
      KOBE_SESSION_KEY_MCP_PROXY: "s".repeat(48),
      KOBE_MCP_INTERNAL_KEY: "i".repeat(48),
    });
    expect(config.serverUrl).toBe("http://kobe-server:8082");
    expect(config.upstream).toEqual({
      allowInsecureHttp: false,
      allowedPorts: [443],
      allowedInternalCidrs: [],
      deniedCidrs: [],
    });
    expect(config.limits.upstreamTimeoutMs).toBe(55_000);
  });

  it("generates and keeps the internal key unless an existing Secret is named", () => {
    const secret = find(ms, "Secret", "kobe-mcp-proxy-internal");
    expect(secret?.metadata).toMatchObject({ annotations: { "helm.sh/resource-policy": "keep" } });
    expect(secret?.stringData.key).toHaveLength(48);
    const own = render({ "mcpProxy.internalKeySecret": "my-key" });
    expect(find(own, "Secret", "kobe-mcp-proxy-internal")).toBeUndefined();
    expect(
      envOf(own, "kobe-mcp-proxy").find((e) => e.name === "KOBE_MCP_INTERNAL_KEY")?.valueFrom,
    ).toEqual({ secretKeyRef: { name: "my-key", key: "key" } });
  });
});

describe("server internal listener", () => {
  const ms = render();

  it("serves the internal port with the key; the scheduler gets neither", () => {
    const server = envOf(ms, "kobe-server");
    expect(plain(server).KOBE_INTERNAL_PORT).toBe("8082");
    expect(server.find((e) => e.name === "KOBE_MCP_PROXY_INTERNAL_KEY")?.valueFrom).toEqual({
      secretKeyRef: { name: "kobe-mcp-proxy-internal", key: "key" },
    });
    expect(pod(ms, "kobe-server")?.containers[0].ports).toContainEqual({
      name: "internal",
      containerPort: 8082,
    });
    expect(find(ms, "Service", "kobe-server")?.spec.ports).toContainEqual({
      name: "internal",
      port: 8082,
      targetPort: "internal",
    });
    expect(envOf(ms, "kobe-scheduler").some((e) => e.name === "KOBE_MCP_PROXY_INTERNAL_KEY")).toBe(
      false,
    );
  });
});

describe("MCP proxy NetworkPolicy", () => {
  it("admits only team namespaces (sandboxes), only on the proxy port", () => {
    expect(policy(render())?.ingress).toEqual([
      {
        from: [
          {
            namespaceSelector: { matchLabels: { "kobe.splittingatom.io/team-namespace": "true" } },
          },
        ],
        ports: [{ protocol: "TCP", port: 8080 }],
      },
    ]);
  });

  it("limits egress to DNS, the server's internal port and public addresses on allowed ports", () => {
    const spec = policy(render());
    expect(spec?.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(spec?.egress).toContainEqual({
      to: [
        {
          podSelector: {
            matchLabels: {
              "app.kubernetes.io/name": "kobe",
              "app.kubernetes.io/instance": "kobe",
              "app.kubernetes.io/component": "server",
            },
          },
        },
      ],
      ports: [{ protocol: "TCP", port: 8082 }],
    });
    const internet = spec?.egress.find((r: any) => r.to?.[0]?.ipBlock?.cidr === "0.0.0.0/0");
    expect(internet.ports).toEqual([{ protocol: "TCP", port: 443 }]);
    expect(internet.to[0].ipBlock.except).toEqual(
      expect.arrayContaining(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"]),
    );
    // No database: the proxy never talks to Postgres.
    expect(spec?.egress.some((r: any) => r.ports?.some((p: any) => p.port === 5432))).toBe(false);
    expect(spec?.egress.every((r: any) => Array.isArray(r.ports) && r.ports.length > 0)).toBe(true);
  });

  it("adds allowed internal targets and ports to both the config and the policy", () => {
    const ms = render(
      {},
      { "mcpProxy.allowedInternalCidrs": ["10.0.5.0/24"], "mcpProxy.allowedPorts": [443, 8443] },
    );
    expect(plain(envOf(ms, "kobe-mcp-proxy"))).toMatchObject({
      KOBE_MCP_ALLOWED_INTERNAL_CIDRS: "10.0.5.0/24",
      KOBE_MCP_ALLOWED_PORTS: "443,8443",
    });
    // The server validates registered connector URLs against the same policy (KOBE-100).
    expect(plain(envOf(ms, "kobe-server"))).toMatchObject({
      KOBE_MCP_ALLOWED_INTERNAL_CIDRS: "10.0.5.0/24",
      KOBE_MCP_ALLOWED_PORTS: "443,8443",
      KOBE_MCP_ALLOW_INSECURE_HTTP: "false",
    });
    expect(policy(ms)?.egress).toContainEqual({
      to: [{ ipBlock: { cidr: "10.0.5.0/24" } }],
      ports: [
        { protocol: "TCP", port: 443 },
        { protocol: "TCP", port: 8443 },
      ],
    });
  });

  it("rejects unknown values (schema)", () => {
    expect(() => render({ "mcpProxy.allowStdio": "true" })).toThrow();
  });
});
