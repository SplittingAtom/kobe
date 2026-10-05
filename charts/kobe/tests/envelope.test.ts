import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// Render tests for the envelope-encryption key (KOBE-107).

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

const find = (ms: Manifest[], kind: string, name: string) =>
  ms.find((m) => m.kind === kind && m.metadata.name === name);
const keyVars = (ms: Manifest[], deployment: string) =>
  (
    (find(ms, "Deployment", deployment)?.spec.template.spec.containers[0].env ?? []) as any[]
  ).filter((e) => e.name.startsWith("KOBE_ENVELOPE_KEY"));

describe("envelope key (KOBE-107)", () => {
  const ms = render();

  it("is generated, kept across upgrades, and given to the server only", () => {
    const secret = find(ms, "Secret", "kobe-envelope-key");
    expect(secret?.metadata).toMatchObject({ annotations: { "helm.sh/resource-policy": "keep" } });
    expect((secret?.stringData as Record<string, string>).key).toMatch(/^[A-Za-z0-9]{48}$/);
    expect(keyVars(ms, "kobe-server")).toEqual([
      {
        name: "KOBE_ENVELOPE_KEY",
        valueFrom: { secretKeyRef: { name: "kobe-envelope-key", key: "key" } },
      },
      {
        name: "KOBE_ENVELOPE_KEY_PREVIOUS",
        valueFrom: {
          secretKeyRef: { name: "kobe-envelope-key", key: "key-previous", optional: true },
        },
      },
    ]);
    for (const other of [
      "kobe-scheduler",
      "kobe-mcp-proxy",
      "kobe-egress-proxy",
      "kobe-model-gateway",
      "kobe-web",
    ]) {
      expect(keyVars(ms, other), other).toEqual([]);
    }
  });

  it("never renders the key into a ConfigMap or the values", () => {
    const key = (find(ms, "Secret", "kobe-envelope-key")?.stringData as { key: string }).key;
    const others = JSON.stringify(ms.filter((m) => m.kind !== "Secret"));
    expect(others).not.toContain(key);
  });

  it("uses an existing Secret instead when named", () => {
    const named = render({ "envelope.keySecret": "my-envelope" });
    expect(find(named, "Secret", "kobe-envelope-key")).toBeUndefined();
    expect(keyVars(named, "kobe-server")[0]?.valueFrom.secretKeyRef.name).toBe("my-envelope");
  });
});
