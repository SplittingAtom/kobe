import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// Render tests for KOBE-182: server.extraCaBundle (a private CA for outgoing TLS, mounted and named
// by NODE_EXTRA_CA_CERTS) and the syslog SD-ID enterprise number.

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
const BUNDLE = "/etc/kobe/extra-ca/ca-bundle.pem";

type Manifest = { kind: string; metadata: { name: string }; [k: string]: any };
type Env = { name: string; value?: string };

function helm(values: Record<string, string>): string {
  const args = Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
  return execFileSync(HELM, ["template", "kobe", CHART_DIR, "-n", "kobe", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

function renderError(values: Record<string, string>): string {
  try {
    helm(values);
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
  throw new Error(`expected helm template to fail for ${JSON.stringify(values)}`);
}

function podSpec(deployment: string, values: Record<string, string> = {}) {
  const ms = parseAllDocuments(helm(values))
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
  const dep = ms.find((m) => m.kind === "Deployment" && m.metadata.name === deployment);
  return dep?.spec.template.spec;
}

const container = (spec: any) => spec.containers[0];
const envNamed = (spec: any, name: string) =>
  (container(spec).env as Env[]).find((e) => e.name === name);

describe("server.extraCaBundle", () => {
  it("mounts nothing and sets nothing by default", () => {
    const spec = podSpec("kobe-server");
    expect(envNamed(spec, "NODE_EXTRA_CA_CERTS")).toBeUndefined();
    expect(spec.volumes.map((v: { name: string }) => v.name)).not.toContain("extra-ca");
  });

  it("mounts a key of a Secret read-only and points NODE_EXTRA_CA_CERTS at it", () => {
    const spec = podSpec("kobe-server", {
      "server.extraCaBundle.secretName": "siem-ca",
      "server.extraCaBundle.key": "root.pem",
    });
    expect(envNamed(spec, "NODE_EXTRA_CA_CERTS")).toEqual({
      name: "NODE_EXTRA_CA_CERTS",
      value: BUNDLE,
    });
    expect(container(spec).volumeMounts).toContainEqual({
      name: "extra-ca",
      mountPath: "/etc/kobe/extra-ca",
      readOnly: true,
    });
    expect(spec.volumes).toContainEqual({
      name: "extra-ca",
      secret: { secretName: "siem-ca", items: [{ key: "root.pem", path: "ca-bundle.pem" }] },
    });
  });

  it("mounts a ConfigMap (default key ca.crt), e.g. one filled by trust-manager", () => {
    const spec = podSpec("kobe-server", { "server.extraCaBundle.configMapName": "corp-roots" });
    expect(envNamed(spec, "NODE_EXTRA_CA_CERTS")?.value).toBe(BUNDLE);
    expect(spec.volumes).toContainEqual({
      name: "extra-ca",
      configMap: { name: "corp-roots", items: [{ key: "ca.crt", path: "ca-bundle.pem" }] },
    });
  });

  it("is the server's only: the scheduler does not forward audit events", () => {
    const spec = podSpec("kobe-scheduler", { "server.extraCaBundle.secretName": "siem-ca" });
    expect(envNamed(spec, "NODE_EXTRA_CA_CERTS")).toBeUndefined();
  });

  it("refuses both sources at once, and bad names", () => {
    expect(
      renderError({
        "server.extraCaBundle.secretName": "a",
        "server.extraCaBundle.configMapName": "b",
      }),
    ).toMatch(/extraCaBundle/);
    expect(renderError({ "server.extraCaBundle.secretName": "Not_A_Name" })).toMatch(
      /extraCaBundle/,
    );
    expect(renderError({ "server.extraCaBundle.key": "../etc/passwd" })).toMatch(/extraCaBundle/);
  });
});

describe("auditForwarding.syslog.enterpriseNumber", () => {
  const syslog = { "auditForwarding.syslog.enabled": "true", "auditForwarding.syslog.host": "h" };
  const pen = (values: Record<string, string>) =>
    envNamed(
      podSpec("kobe-server", { ...syslog, ...values }),
      "KOBE_AUDIT_SYSLOG_ENTERPRISE_NUMBER",
    )?.value;

  it("defaults to the documentation number 32473", () => {
    expect(pen({})).toBe("32473");
  });

  it("passes a registered PEN to the server", () => {
    expect(pen({ "auditForwarding.syslog.enterpriseNumber": "61234" })).toBe("61234");
  });

  it("is not set while syslog forwarding is off", () => {
    const spec = podSpec("kobe-server");
    expect(envNamed(spec, "KOBE_AUDIT_SYSLOG_ENTERPRISE_NUMBER")).toBeUndefined();
  });

  it("accepts digits only", () => {
    for (const bad of ["abc", "0", "12.5"]) {
      expect(
        renderError({ ...syslog, "auditForwarding.syslog.enterpriseNumber": bad }),
        bad,
      ).toMatch(/enterpriseNumber/);
    }
  });
});
