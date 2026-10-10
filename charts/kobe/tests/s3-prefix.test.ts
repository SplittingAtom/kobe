import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// Render tests for s3.prefix (KOBE-195): chart value -> KOBE_S3_PREFIX on server and scheduler.

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

function helm(values: Record<string, string>): string {
  const args = Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
  return execFileSync(HELM, ["template", "kobe", CHART_DIR, "-n", "kobe", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

function prefixOf(deployment: string, values: Record<string, string> = {}): string | undefined {
  const ms = parseAllDocuments(helm(values))
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
  const dep = ms.find((m) => m.kind === "Deployment" && m.metadata.name === deployment);
  const env = (dep?.spec.template.spec.containers[0].env ?? []) as {
    name: string;
    value?: string;
  }[];
  return env.find((e) => e.name === "KOBE_S3_PREFIX")?.value;
}

describe("s3.prefix", () => {
  it.each(["kobe-server", "kobe-scheduler"])("defaults to empty on %s", (name) => {
    expect(prefixOf(name)).toBe("");
  });

  it.each(["kobe-server", "kobe-scheduler"])("sets KOBE_S3_PREFIX on %s", (name) => {
    expect(prefixOf(name, { "s3.prefix": "team-a/kobe/" })).toBe("team-a/kobe/");
  });

  it.each(["/abs/", "no-trailing-slash", "bad prefix/", "a\\\\b/"])("rejects %s", (v) => {
    expect(() => helm({ "s3.prefix": v })).toThrow();
  });
});
