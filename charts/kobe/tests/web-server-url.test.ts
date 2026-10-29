import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// KOBE-500 (theming plan TH5): the web gets KOBE_SERVER_URL, the server's in-cluster origin, for
// the site branding of every server render. Default: this release's server Service (port 80).

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
type EnvVar = { name: string; value?: string };

function helm(values: Record<string, string>, release = "kobe"): string {
  const args = Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
  return execFileSync(HELM, ["template", release, CHART_DIR, "-n", "kobe", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

function envOf(
  deployment: string,
  values: Record<string, string> = {},
  release = "kobe",
): EnvVar[] {
  const ms = parseAllDocuments(helm(values, release))
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
  const dep = ms.find((m) => m.kind === "Deployment" && m.metadata.name === deployment);
  return (dep?.spec.template.spec.containers[0].env ?? []) as EnvVar[];
}

const serverUrl = (env: EnvVar[]) => env.find((e) => e.name === "KOBE_SERVER_URL")?.value;

describe("web.serverUrl -> KOBE_SERVER_URL", () => {
  it("defaults to this release's server Service", () => {
    expect(serverUrl(envOf("kobe-web"))).toBe("http://kobe-server");
    expect(serverUrl(envOf("other-web", {}, "other"))).toBe("http://other-server");
  });

  it("is overridable for split installs, without a trailing slash", () => {
    expect(serverUrl(envOf("kobe-web", { "web.serverUrl": "https://api.internal:8443/" }))).toBe(
      "https://api.internal:8443",
    );
  });

  it("is set on the web only", () => {
    for (const name of ["kobe-server", "kobe-scheduler", "kobe-mcp-proxy", "kobe-egress-proxy"]) {
      expect(serverUrl(envOf(name)), name).toBeUndefined();
    }
  });

  it.each(["kobe-server", "ftp://kobe-server", "http://kobe-server/v1", "http://a b"])(
    "rejects %s",
    (v) => {
      expect(() => helm({ "web.serverUrl": v })).toThrow();
    },
  );
});
