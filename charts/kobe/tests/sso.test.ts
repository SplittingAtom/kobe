import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSsoSettings } from "../../../services/server/src/sso/settings.js";
import { describe, expect, it } from "vitest";
import { parseAllDocuments, stringify } from "yaml";

// Render tests for KOBE-626: auth.sso (kill switch, SSRF exceptions, Helm providers with their
// client secret from a Secret reference, the optional server egress NetworkPolicy) and its schema.

const CHART_DIR = fileURLToPath(new URL("..", import.meta.url));
const HELM = process.env.HELM_BIN ?? "helm";
const BASE = {
  ingress: { host: "kobe.example.com" },
  postgres: { external: { existingSecret: "kobe-db" } },
  s3: { endpoint: "https://s3.example.com", bucket: "kobe", existingSecret: "kobe-s3" },
  smtp: { host: "smtp.example.com", from: "Kobe <kobe@example.com>" },
  global: { allowGeneratedSecretsOffline: true },
};
const TENANT = "11111111-2222-4333-8444-555555555555";

type Manifest = { kind: string; metadata: { name: string }; [k: string]: any };
type Env = { name: string; value?: string; valueFrom?: unknown };

function helm(sso: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "kobe-sso-chart-"));
  const file = join(dir, "values.yaml");
  writeFileSync(file, stringify({ ...BASE, auth: { sso } }));
  return execFileSync(HELM, ["template", "kobe", CHART_DIR, "-n", "kobe", "-f", file], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

function renderError(sso: unknown): string {
  try {
    helm(sso);
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
  throw new Error(`expected helm template to fail for ${JSON.stringify(sso)}`);
}

function manifests(sso: unknown): Manifest[] {
  return parseAllDocuments(helm(sso))
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
}

function envOf(ms: Manifest[], deployment: string): Env[] {
  const dep = ms.find((m) => m.kind === "Deployment" && m.metadata.name === deployment);
  return dep?.spec.template.spec.containers[0].env as Env[];
}

const plain = (env: Env[]) =>
  Object.fromEntries(env.filter((e) => e.value !== undefined).map((e) => [e.name, e.value]));

const provider = {
  slug: "contoso-corp",
  displayName: "Contoso",
  kind: "entra",
  tenantId: TENANT,
  clientId: "app-id",
  clientSecretSecret: { name: "kobe-sso-contoso", key: "client-secret" },
  accessClaim: "roles",
};

describe("auth.sso (KOBE-626 ac-7)", () => {
  it("is on with no providers by default, on the API server only", () => {
    const ms = manifests({});
    const server = plain(envOf(ms, "kobe-server"));
    expect(server).toMatchObject({
      KOBE_SSO_ENABLED: "true",
      KOBE_SSO_ALLOWED_INTERNAL_CIDRS: "",
      KOBE_SSO_ALLOWED_PORTS: "443",
      KOBE_SSO_PROVIDERS: "[]",
    });
    const scheduler = envOf(ms, "kobe-scheduler").map((e) => e.name);
    expect(scheduler.filter((n) => n.startsWith("KOBE_SSO_"))).toEqual([]);
    expect(ms.some((m) => m.metadata.name === "kobe-server-sso-egress")).toBe(false);
  });

  it("renders the kill switch", () => {
    expect(plain(envOf(manifests({ enabled: false }), "kobe-server")).KOBE_SSO_ENABLED).toBe(
      "false",
    );
  });

  it("passes providers without their secret, and the secret by reference", () => {
    const env = envOf(
      manifests({ providers: [provider], allowedInternalCidrs: ["10.20.0.0/16"] }),
      "kobe-server",
    );
    const values = plain(env);
    expect(values.KOBE_SSO_ALLOWED_INTERNAL_CIDRS).toBe("10.20.0.0/16");
    const declared = JSON.parse(values.KOBE_SSO_PROVIDERS ?? "[]");
    expect(declared).toEqual([
      {
        slug: "contoso-corp",
        displayName: "Contoso",
        kind: "entra",
        tenantId: TENANT,
        clientId: "app-id",
        accessClaim: "roles",
      },
    ]);
    expect(env.find((e) => e.name === "KOBE_SSO_CLIENT_SECRET_CONTOSO_CORP")).toEqual({
      name: "KOBE_SSO_CLIENT_SECRET_CONTOSO_CORP",
      valueFrom: { secretKeyRef: { name: "kobe-sso-contoso", key: "client-secret" } },
    });
    // The server reads exactly what the chart renders.
    const settings = loadSsoSettings({
      ...values,
      KOBE_SSO_CLIENT_SECRET_CONTOSO_CORP: "from-the-secret",
    });
    expect(settings.helmProviders[0]).toMatchObject({
      slug: "contoso-corp",
      issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    });
    expect(settings.helmSecrets.get("contoso-corp")).toBe("from-the-secret");
  });

  it.each([
    ["a multi-tenant authority", { ...provider, tenantId: "common" }],
    ["an issuer on an Entra provider", { ...provider, issuer: "https://x.example.com" }],
    ["a generic provider without an issuer", { ...provider, kind: "oidc", tenantId: undefined }],
    [
      "an http issuer",
      { ...provider, kind: "oidc", tenantId: undefined, issuer: "http://x.example.com" },
    ],
    ["an inline secret", { ...provider, clientSecret: "inline" }],
    ["no secret reference", { ...provider, clientSecretSecret: undefined }],
    ["a bad slug", { ...provider, slug: "Contoso" }],
  ])("the schema refuses %s", (_what, p) => {
    expect(renderError({ providers: [p] })).toMatch(/values don't meet the specifications|schema/i);
  });

  it("the schema refuses a bad CIDR and unknown keys", () => {
    expect(renderError({ allowedInternalCidrs: ["ten.0.0.0/8"] })).toMatch(
      /schema|specifications/i,
    );
    expect(renderError({ allowAll: true })).toMatch(/schema|specifications|additional/i);
  });

  it("renders the optional egress NetworkPolicy for the server", () => {
    const ms = manifests({
      allowedInternalCidrs: ["10.20.0.0/16"],
      allowedPorts: [443, 8443],
      networkPolicy: { enabled: true },
    });
    const np = ms.find((m) => m.metadata.name === "kobe-server-sso-egress");
    expect(np?.kind).toBe("NetworkPolicy");
    expect(np?.spec.policyTypes).toEqual(["Egress"]);
    expect(np?.spec.podSelector.matchLabels).toMatchObject({
      "app.kubernetes.io/component": "server",
    });
    const rules = np?.spec.egress as any[];
    expect(rules[0].ports).toContainEqual({ protocol: "UDP", port: 53 });
    expect(rules[1].to[0].ipBlock.cidr).toBe("0.0.0.0/0");
    expect(rules[1].to[0].ipBlock.except).toContain("10.0.0.0/8");
    expect(rules[1].ports).toEqual([
      { protocol: "TCP", port: 443 },
      { protocol: "TCP", port: 8443 },
    ]);
    expect(rules[2].to[0].ipBlock.cidr).toBe("10.20.0.0/16");
    // Not with the kill switch on.
    const off = manifests({ enabled: false, networkPolicy: { enabled: true } });
    expect(off.some((m) => m.metadata.name === "kobe-server-sso-egress")).toBe(false);
  });

  it("limits the NetworkPolicy to listed CIDRs when given", () => {
    const np = manifests({ networkPolicy: { enabled: true, cidrs: ["20.190.128.0/18"] } }).find(
      (m) => m.metadata.name === "kobe-server-sso-egress",
    );
    expect(np?.spec.egress[1].to[0].ipBlock).toEqual({ cidr: "20.190.128.0/18" });
  });
});
