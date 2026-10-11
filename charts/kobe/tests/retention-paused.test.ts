import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// Render tests for retention.paused (KOBE-243): chart value -> KOBE_RETENTION_PAUSED.

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

function pausedOf(deployment: string, values: Record<string, string> = {}): string | undefined {
  const args = Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
  const out = execFileSync(HELM, ["template", "kobe", CHART_DIR, "-n", "kobe", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
  const ms = parseAllDocuments(out)
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
  const dep = ms.find((m) => m.kind === "Deployment" && m.metadata.name === deployment);
  const env = (dep?.spec.template.spec.containers[0].env ?? []) as {
    name: string;
    value?: string;
  }[];
  return env.find((e) => e.name === "KOBE_RETENTION_PAUSED")?.value;
}

describe("retention.paused", () => {
  it.each(["kobe-server", "kobe-scheduler"])("is false by default on %s", (name) => {
    expect(pausedOf(name)).toBe("false");
  });

  it.each(["kobe-server", "kobe-scheduler"])("sets KOBE_RETENTION_PAUSED on %s", (name) => {
    expect(pausedOf(name, { "retention.paused": "true" })).toBe("true");
  });
});
