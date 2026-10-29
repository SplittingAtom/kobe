import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// Render tests for the chart-seeded branding defaults (KOBE-503): branding.* -> KOBE_BRANDING_*
// on the API server only, and only the values that are set.

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

function render(values: Record<string, string> = {}): string {
  const args = Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
  return execFileSync(HELM, ["template", "kobe", CHART_DIR, "-n", "kobe", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

function brandingEnv(deployment: string, values: Record<string, string> = {}) {
  const ms = parseAllDocuments(render(values))
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
  const dep = ms.find((m) => m.kind === "Deployment" && m.metadata.name === deployment);
  const env = (dep?.spec.template.spec.containers[0].env ?? []) as {
    name: string;
    value?: string;
  }[];
  return Object.fromEntries(
    env.filter((e) => e.name.startsWith("KOBE_BRANDING_")).map((e) => [e.name, e.value]),
  );
}

describe("branding.* (KOBE-503)", () => {
  it("renders nothing by default", () => {
    expect(brandingEnv("kobe-server")).toEqual({});
  });

  it("renders the set values on the API server", () => {
    expect(
      brandingEnv("kobe-server", {
        "branding.appName": "Acme Assist",
        "branding.preset": "tokyo-nights",
        "branding.showName": "false",
      }),
    ).toEqual({
      KOBE_BRANDING_APP_NAME: "Acme Assist",
      KOBE_BRANDING_PRESET: "tokyo-nights",
      KOBE_BRANDING_SHOW_NAME: "false",
    });
  });

  it("leaves show-name out while it is true (the default)", () => {
    expect(brandingEnv("kobe-server", { "branding.showName": "true" })).toEqual({});
  });

  it("is not given to the scheduler", () => {
    expect(brandingEnv("kobe-scheduler", { "branding.preset": "slate" })).toEqual({});
  });

  it("refuses a preset the server does not know", () => {
    expect(() => render({ "branding.preset": "neon" })).toThrow(/branding/);
  });
});
