import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// Render tests for the upload settings (KOBE-185): chart values -> server env, defaults equal the
// code defaults in services/server/src/uploads/settings.ts.

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

function serverEnv(values: Record<string, string> = {}): Record<string, string> {
  const ms = parseAllDocuments(helm(values))
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
  const dep = ms.find((m) => m.kind === "Deployment" && m.metadata.name === "kobe-server");
  const env = (dep?.spec.template.spec.containers[0].env ?? []) as {
    name: string;
    value?: string;
  }[];
  return Object.fromEntries(env.map((e) => [e.name, e.value ?? ""]));
}

describe("upload settings", () => {
  it("defaults to the server's code defaults", () => {
    const env = serverEnv();
    expect(env.KOBE_UPLOAD_MAX_FILE_BYTES).toBe(String(100 * 1024 ** 2));
    expect(env.KOBE_UPLOAD_MAX_MESSAGE_BYTES).toBe(String(500 * 1024 ** 2));
    expect(env.KOBE_TEAM_STORAGE_QUOTA_BYTES).toBe(String(10 * 1024 ** 3));
    expect(env.KOBE_UPLOAD_ORPHAN_HOURS).toBe("24");
  });

  it("passes overrides through as plain integers", () => {
    const env = serverEnv({
      "server.uploads.maxFileBytes": "2097152",
      "server.uploads.maxMessageBytes": "4194304",
      "server.uploads.teamStorageQuotaBytes": "53687091200",
      "server.uploads.orphanHours": "72",
    });
    expect(env).toMatchObject({
      KOBE_UPLOAD_MAX_FILE_BYTES: "2097152",
      KOBE_UPLOAD_MAX_MESSAGE_BYTES: "4194304",
      KOBE_TEAM_STORAGE_QUOTA_BYTES: "53687091200",
      KOBE_UPLOAD_ORPHAN_HOURS: "72",
    });
  });

  it("rejects out-of-range values in the schema", () => {
    expect(() => helm({ "server.uploads.orphanHours": "721" })).toThrow();
    expect(() => helm({ "server.uploads.maxFileBytes": "0" })).toThrow();
    expect(() => helm({ "server.uploads.bogus": "1" })).toThrow();
  });
});
