import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { loadConfig as loadShimConfig } from "../../../services/model-gateway/src/config.js";
import { loadModelsConfig } from "../../../services/server/src/models/config.js";

// Render tests for the model gateway (KOBE-40): Bifrost, the model-gateway shim, their secrets
// and NetworkPolicies, and how sandboxes reach them.

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

function helm(values: Record<string, string>, json: Record<string, unknown> = {}): string {
  const args = [
    ...Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]),
    ...Object.entries(json).flatMap(([k, v]) => ["--set-json", `${k}=${JSON.stringify(v)}`]),
  ];
  return execFileSync(HELM, ["template", "kobe", CHART_DIR, "-n", "kobe", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

function render(values: Record<string, string> = {}, json: Record<string, unknown> = {}) {
  return parseAllDocuments(helm(values, json))
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
}

const find = (ms: Manifest[], kind: string, name: string) =>
  ms.find((m) => m.kind === kind && m.metadata.name === name);
const pod = (ms: Manifest[], name: string) => find(ms, "Deployment", name)?.spec.template.spec;
const env = (ms: Manifest[], name: string): EnvVar[] => pod(ms, name)?.containers[0].env ?? [];
const secretKeys = (vars: EnvVar[]) =>
  vars
    .filter((v) => v.valueFrom?.secretKeyRef)
    .map((v) => `${v.valueFrom.secretKeyRef.name}/${v.valueFrom.secretKeyRef.key}`)
    .sort();
/** Env as a service would see it: Secret references replaced by distinct 48-char stand-ins. */
const resolved = (vars: EnvVar[]) =>
  Object.fromEntries(
    vars.map((v, i) => [v.name, v.value ?? `${String(i).padStart(2, "0")}${"s".repeat(46)}`]),
  );

describe("Bifrost", () => {
  const ms = render();
  const spec = pod(ms, "kobe-bifrost");

  it("runs the pinned Apache-2.0 image by digest, one replica, never two at once", () => {
    expect(spec?.containers[0].image).toBe(
      "docker.io/maximhq/bifrost:v2.2.5@sha256:65854fd1941ba8159f1f98cd69df380f6e8ac8cd374bde632c4e28f822a6f115",
    );
    const deployment = find(ms, "Deployment", "kobe-bifrost");
    expect(deployment?.spec.replicas).toBe(1);
    expect(deployment?.spec.strategy).toEqual({ type: "Recreate" });
    expect(() => helm({ "bifrost.replicas": "2" })).toThrow(/maximum|replicas/);
  });

  it("pins the same image Dependabot tracks (images/bifrost/Dockerfile)", () => {
    const tracked = readFileSync(
      fileURLToPath(new URL("../../../images/bifrost/Dockerfile", import.meta.url)),
      "utf8",
    );
    const from = /^FROM (\S+)$/m.exec(tracked)?.[1];
    expect(spec?.containers[0].image).toBe(from);
    const defaults = readFileSync(
      fileURLToPath(new URL("../templates/_models.tpl", import.meta.url)),
      "utf8",
    );
    const [, repo, tag, digest] = /^(.+):([^:@]+)@(sha256:[0-9a-f]{64})$/.exec(from ?? "") ?? [];
    expect(defaults).toContain(`"repository" "${repo}" "tag" "${tag}" "digest" "${digest}"`);
  });

  it("keeps its store on a volume and reads a secret-free config.json", () => {
    expect(find(ms, "PersistentVolumeClaim", "kobe-bifrost")).toBeDefined();
    const config = JSON.parse(find(ms, "ConfigMap", "kobe-bifrost")?.data["config.json"]);
    expect(config.client).toMatchObject({
      enforce_auth_on_inference: true,
      allow_direct_keys: false,
      enable_logging: false,
      disable_content_logging: true,
    });
    expect(config.governance.auth_config).toEqual({
      admin_username: "env.BIFROST_ADMIN_USERNAME",
      admin_password: "env.BIFROST_ADMIN_PASSWORD",
      is_enabled: true,
    });
    expect(config.encryption_key).toBe("env.BIFROST_ENCRYPTION_KEY");
    expect(config.logs_store).toEqual({ enabled: false });
    const mounts = spec?.containers[0].volumeMounts as { mountPath: string; readOnly?: boolean }[];
    expect(mounts).toContainEqual(
      expect.objectContaining({ mountPath: "/app/data/config.json", readOnly: true }),
    );
  });

  it("gets its admin password and encryption key, nothing else", () => {
    expect(secretKeys(env(ms, "kobe-bifrost"))).toEqual([
      "kobe-model-keys/bifrost-admin-password",
      "kobe-model-keys/bifrost-encryption-key",
    ]);
  });

  it("generates the model secrets once (kept), or uses bifrost.keysSecret", () => {
    const secret = find(ms, "Secret", "kobe-model-keys");
    expect(Object.keys(secret?.stringData ?? {}).sort()).toEqual([
      "bifrost-admin-password",
      "bifrost-encryption-key",
      "provider-keys",
      "virtual-keys",
    ]);
    expect(secret?.metadata.annotations).toEqual({ "helm.sh/resource-policy": "keep" });
    const own = render({ "bifrost.keysSecret": "my-model-keys" });
    expect(find(own, "Secret", "kobe-model-keys")).toBeUndefined();
    expect(secretKeys(env(own, "kobe-model-gateway"))).toContain("my-model-keys/virtual-keys");
  });
});

describe("who holds which secret", () => {
  const ms = render();

  it("the server reconciles Bifrost: admin password and both sealing secrets", () => {
    const vars = env(ms, "kobe-server");
    expect(secretKeys(vars).filter((k) => k.startsWith("kobe-model-keys/"))).toEqual([
      "kobe-model-keys/bifrost-admin-password",
      "kobe-model-keys/provider-keys",
      "kobe-model-keys/provider-keys-previous",
      "kobe-model-keys/virtual-keys",
      "kobe-model-keys/virtual-keys-previous",
    ]);
    const previous = vars.filter((v) => v.name.endsWith("_PREVIOUS"));
    expect(previous.every((v) => v.valueFrom.secretKeyRef.optional === true)).toBe(true);
    expect(vars).toContainEqual({ name: "KOBE_MODELS_ALLOW_UNSAFE_ENDPOINTS", value: "false" });
    expect(loadModelsConfig(resolved(vars))).toMatchObject({
      bifrostUrl: "http://kobe-bifrost:8080",
      adminUsername: "kobe",
    });
  });

  it("the scheduler holds no model secret", () => {
    expect(secretKeys(env(ms, "kobe-scheduler")).filter((k) => k.includes("model"))).toEqual([]);
  });

  it("the shim holds only its own session key and the virtual-key secret", () => {
    const vars = env(ms, "kobe-model-gateway");
    expect(secretKeys(vars)).toEqual([
      "kobe-db/app-url",
      "kobe-model-keys/virtual-keys",
      "kobe-model-keys/virtual-keys-previous",
      "kobe-sandbox-session-keys/model-gateway",
    ]);
    const shimEnv = resolved(vars.filter((v) => !v.name.endsWith("_PREVIOUS")));
    expect(loadShimConfig(shimEnv)).toMatchObject({
      bifrostUrl: "http://kobe-bifrost:8080",
      maxCallsPerSandbox: 16,
      maxBodyBytes: 8 * 1024 * 1024,
      inflightBytes: 128 * 1024 * 1024,
      rateBurst: 60,
      cacheTtlMs: 5_000,
    });
    expect(find(ms, "Deployment", "kobe-model-gateway")?.spec.replicas).toBe(2);
    const init = pod(ms, "kobe-model-gateway")?.initContainers as { name: string }[];
    expect(init.map((c) => c.name)).toEqual(["wait-for-migrations"]);
  });
});

describe("shim sizing", () => {
  it("refuses a memory limit below the in-flight byte budget + 256Mi (no OOM by uploads)", () => {
    expect(() => helm({ "modelGateway.resources.limits.memory": "256Mi" })).toThrow(
      /must be at least modelGateway.limits.inflightBytes/,
    );
    expect(() =>
      helm({
        "modelGateway.resources.limits.memory": "1Gi",
        "modelGateway.limits.inflightBytes": "536870912",
      }),
    ).not.toThrow();
  });

  it("the operator switch for unsafe endpoints reaches the server only", () => {
    const ms = render({ "bifrost.allowUnsafeProviderEndpoints": "true" });
    expect(env(ms, "kobe-server")).toContainEqual({
      name: "KOBE_MODELS_ALLOW_UNSAFE_ENDPOINTS",
      value: "true",
    });
    expect(env(ms, "kobe-model-gateway").map((v) => v.name)).not.toContain(
      "KOBE_MODELS_ALLOW_UNSAFE_ENDPOINTS",
    );
  });
});

describe("network policies", () => {
  const ms = render({ "postgres.mode": "cnpg" });
  const policy = (name: string) => find(ms, "NetworkPolicy", name)?.spec;
  const component = (c: string) => ({
    "app.kubernetes.io/name": "kobe",
    "app.kubernetes.io/instance": "kobe",
    "app.kubernetes.io/component": c,
  });

  it("Bifrost admits only the shim and the server, on its port; never sandboxes", () => {
    expect(policy("kobe-bifrost")?.ingress).toEqual([
      {
        from: [
          { podSelector: { matchLabels: component("model-gateway") } },
          { podSelector: { matchLabels: component("server") } },
        ],
        ports: [{ protocol: "TCP", port: 8080 }],
      },
    ]);
    expect(JSON.stringify(policy("kobe-bifrost")?.ingress)).not.toContain("team-namespace");
  });

  it("Bifrost's own egress: DNS and public addresses on 443, plus explicit local-model rules", () => {
    const egress = policy("kobe-bifrost")?.egress as any[];
    expect(egress).toHaveLength(2);
    expect(egress[1].to[0].ipBlock.except).toEqual(
      expect.arrayContaining(["10.0.0.0/8", "169.254.0.0/16", "192.168.0.0/16"]),
    );
    expect(egress[1].ports).toEqual([{ protocol: "TCP", port: 443 }]);
    const ollama = {
      to: [{ ipBlock: { cidr: "10.20.30.40/32" } }],
      ports: [{ protocol: "TCP", port: 11434 }],
    };
    const local = render({}, { "bifrost.networkPolicy.extraEgress": [ollama] });
    expect(find(local, "NetworkPolicy", "kobe-bifrost")?.spec.egress).toContainEqual(ollama);
  });

  it("the shim admits only team namespaces and reaches only DNS, Bifrost and Postgres", () => {
    const shim = policy("kobe-model-gateway");
    expect(shim?.ingress).toEqual([
      {
        from: [
          {
            namespaceSelector: { matchLabels: { "kobe.splittingatom.io/team-namespace": "true" } },
          },
        ],
        ports: [{ protocol: "TCP", port: 8080 }],
      },
    ]);
    expect(shim?.egress[1]).toEqual({
      to: [{ podSelector: { matchLabels: component("bifrost") } }],
      ports: [{ protocol: "TCP", port: 8080 }],
    });
    expect(shim?.egress[2].to[0].podSelector.matchLabels).toEqual({ "cnpg.io/cluster": "kobe-pg" });
    expect(shim?.egress).toHaveLength(3);
  });
});
