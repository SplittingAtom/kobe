import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// Render tests for server.modelDefaults (KOBE-259): chart values -> KOBE_MODEL_DEFAULT_*, on the
// server and on the scheduler (which starts scheduled runs and so sends run.start too).

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
const NAMES = [
  "KOBE_MODEL_DEFAULT_MAX_OUTPUT_TOKENS",
  "KOBE_MODEL_DEFAULT_REASONING_MAX_OUTPUT_TOKENS",
  "KOBE_MODEL_DEFAULT_CONTEXT_WINDOW",
];

type Manifest = { kind: string; metadata: { name: string }; [k: string]: any };

function render(values: Record<string, string>): string {
  const args = Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
  return execFileSync(HELM, ["template", "kobe", CHART_DIR, "-n", "kobe", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

function defaultsOf(deployment: string, values: Record<string, string> = {}): string[] {
  const ms = parseAllDocuments(render(values))
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
  const dep = ms.find((m) => m.kind === "Deployment" && m.metadata.name === deployment);
  const env = (dep?.spec.template.spec.containers[0].env ?? []) as {
    name: string;
    value?: string;
  }[];
  return NAMES.map((n) => env.find((e) => e.name === n)?.value ?? "-");
}

describe("server.modelDefaults", () => {
  it.each(["kobe-server", "kobe-scheduler"])("sets the documented defaults on %s", (name) => {
    expect(defaultsOf(name)).toEqual(["16384", "32768", "128000"]);
  });

  it.each(["kobe-server", "kobe-scheduler"])("passes configured values on %s", (name) => {
    expect(
      defaultsOf(name, {
        "server.modelDefaults.maxOutputTokens": "8192",
        "server.modelDefaults.reasoningMaxOutputTokens": "65536",
        "server.modelDefaults.contextWindow": "200000",
      }),
    ).toEqual(["8192", "65536", "200000"]);
  });

  it("refuses values outside the catalog's bounds (schema)", () => {
    for (const [key, bad] of [
      ["server.modelDefaults.maxOutputTokens", "255"],
      ["server.modelDefaults.reasoningMaxOutputTokens", "131073"],
      ["server.modelDefaults.contextWindow", "1023"],
    ]) {
      expect(() => render({ [key as string]: bad as string }), key).toThrow();
    }
  });
});
