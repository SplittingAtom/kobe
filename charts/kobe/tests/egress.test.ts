import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { loadConfig } from "../../../services/egress-proxy/src/config.js";

// Render tests for the egress proxy's chart pieces (KOBE-38): Deployment env, NetworkPolicy.

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

type Manifest = { kind: string; metadata: { name: string; namespace?: string }; [k: string]: any };

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
const proxyPod = (ms: Manifest[]) =>
  find(ms, "Deployment", "kobe-egress-proxy")?.spec.template.spec;
const proxyEnv = (ms: Manifest[]): { name: string; value?: string; valueFrom?: any }[] =>
  proxyPod(ms)?.containers[0].env ?? [];
const policy = (ms: Manifest[]) => find(ms, "NetworkPolicy", "kobe-egress-proxy")?.spec;

describe("egress proxy Deployment", () => {
  const ms = render();

  it("renders as its own documents next to the MCP proxy (Deployment and Service each)", () => {
    for (const name of ["kobe-mcp-proxy", "kobe-egress-proxy"]) {
      expect(find(ms, "Deployment", name), name).toBeDefined();
      expect(find(ms, "Service", name), name).toBeDefined();
    }
  });

  it("gets only its own session key, the app-role database URL, and waits for migrations", () => {
    const env = proxyEnv(ms);
    const keys = env.filter((e) => e.name.startsWith("KOBE_SESSION_KEY_"));
    expect(keys).toEqual([
      {
        name: "KOBE_SESSION_KEY_EGRESS_PROXY",
        valueFrom: { secretKeyRef: { name: "kobe-sandbox-session-keys", key: "egress-proxy" } },
      },
    ]);
    expect(env.find((e) => e.name === "KOBE_DATABASE_URL")?.valueFrom.secretKeyRef.key).toBe(
      "app-url",
    );
    expect(proxyPod(ms)?.initContainers.map((c: { name: string }) => c.name)).toEqual([
      "wait-for-migrations",
    ]);
    expect(proxyPod(ms)?.automountServiceAccountToken).toBe(false);
  });

  it("renders env the proxy's config schema accepts (HTTPS only by default)", () => {
    const vars = Object.fromEntries(
      proxyEnv(ms)
        .filter((e) => e.value !== undefined)
        .map((e) => [e.name, e.value]),
    );
    const config = loadConfig({
      ...vars,
      KOBE_DATABASE_URL: "postgres://x",
      KOBE_SESSION_KEY_EGRESS_PROXY: "k".repeat(48),
    });
    expect(config.allowedPorts).toEqual([443]);
    expect(config.allowedInternalCidrs).toEqual([]);
    expect(config.maxConnectionsPerSandbox).toBe(64);
    expect(config.idleTimeoutMs).toBe(300_000);
  });
});

describe("egress proxy NetworkPolicy", () => {
  it("admits only team namespaces (sandboxes), only on the proxy port", () => {
    const spec = policy(render());
    expect(spec?.ingress).toEqual([
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

  it("limits the proxy's own egress to DNS, Postgres and public addresses on allowed ports", () => {
    const spec = policy(render());
    expect(spec?.policyTypes).toEqual(["Ingress", "Egress"]);
    const internet = spec?.egress.find((r: any) => r.to?.[0]?.ipBlock?.cidr === "0.0.0.0/0");
    expect(internet.ports).toEqual([{ protocol: "TCP", port: 443 }]);
    expect(internet.to[0].ipBlock.except).toEqual(
      expect.arrayContaining([
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "127.0.0.0/8",
        "100.64.0.0/10",
      ]),
    );
    const dns = spec?.egress.find((r: any) => r.ports?.some((p: any) => p.port === 53));
    expect(dns.to[0].podSelector.matchLabels).toEqual({ "k8s-app": "kube-dns" });
    // Every rule names its ports: nothing else is reachable on any port.
    expect(spec?.egress.every((r: any) => Array.isArray(r.ports) && r.ports.length > 0)).toBe(true);
  });

  it("narrows Postgres to the configured peers, or to the CNPG cluster", () => {
    const peers = [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "db" } } }];
    const external = policy(render({}, { "egressProxy.networkPolicy.databasePeers": peers }));
    expect(external?.egress).toContainEqual({
      to: peers,
      ports: [{ protocol: "TCP", port: 5432 }],
    });
    const cnpg = policy(render({ "postgres.mode": "cnpg" }));
    expect(cnpg?.egress).toContainEqual({
      to: [{ podSelector: { matchLabels: { "cnpg.io/cluster": "kobe-pg" } } }],
      ports: [{ protocol: "TCP", port: 5432 }],
    });
  });

  it("adds explicitly allowed internal targets to both the proxy config and its policy", () => {
    const ms = render({}, { "egressProxy.allowedInternalCidrs": ["10.43.200.200/32"] });
    expect(proxyEnv(ms).find((e) => e.name === "KOBE_EGRESS_ALLOWED_INTERNAL_CIDRS")?.value).toBe(
      "10.43.200.200/32",
    );
    expect(policy(ms)?.egress).toContainEqual({
      to: [{ ipBlock: { cidr: "10.43.200.200/32" } }],
      ports: [{ protocol: "TCP", port: 443 }],
    });
  });

  it("can leave the proxy's egress unrestricted (ingress stays restricted)", () => {
    const spec = policy(render({ "egressProxy.networkPolicy.restrictEgress": "false" }));
    expect(spec?.policyTypes).toEqual(["Ingress"]);
    expect(spec?.egress).toBeUndefined();
  });
});

describe("sandbox side", () => {
  it("team namespaces send sandboxes to the proxy pods on 8080 (server config)", () => {
    const server = find(render(), "Deployment", "kobe-server")?.spec.template.spec.containers[0];
    const cfg = JSON.parse(
      server.env.find((e: { name: string }) => e.name === "KOBE_SANDBOX_CONFIG").value,
    );
    expect(cfg.endpoints.egressProxy).toMatchObject({
      service: "kobe-egress-proxy",
      port: 80,
      targetPort: 8080,
      podLabels: { "app.kubernetes.io/component": "egress-proxy" },
    });
  });
});
