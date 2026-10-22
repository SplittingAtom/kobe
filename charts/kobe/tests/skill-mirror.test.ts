import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// Render tests for server.skillMirror (KOBE-343): the catalog git mirror's token comes from an
// existing Secret (optional, never a value), the identity from values; only the server gets them.

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
type Env = { name: string; value?: string; valueFrom?: unknown };

function render(values: Record<string, string>): Manifest[] {
  const args = Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
  const out = execFileSync(HELM, ["template", "kobe", CHART_DIR, "-n", "kobe", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return parseAllDocuments(out)
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
}

const envOf = (ms: Manifest[], name: string): Env[] =>
  ms.find((m) => m.kind === "Deployment" && m.metadata.name === name)?.spec.template.spec
    .containers[0].env ?? [];
const mirrorEnv = (env: Env[]) => env.filter((e) => e.name.startsWith("KOBE_SKILL_MIRROR_"));

describe("server.skillMirror", () => {
  it("defaults: identity only, no token", () => {
    expect(mirrorEnv(envOf(render({}), "kobe-server"))).toEqual([
      { name: "KOBE_SKILL_MIRROR_USERNAME", value: "x-access-token" },
      { name: "KOBE_SKILL_MIRROR_AUTHOR_NAME", value: "Kobe Registry" },
      { name: "KOBE_SKILL_MIRROR_AUTHOR_EMAIL", value: "registry@kobe.invalid" },
    ]);
  });

  it("reads the token from the named Secret (optional), on the server only", () => {
    const ms = render({
      "server.skillMirror.tokenSecret.name": "mirror-token",
      "server.skillMirror.tokenSecret.key": "pat",
      "server.skillMirror.username": "kobe-bot",
    });
    expect(mirrorEnv(envOf(ms, "kobe-server"))).toContainEqual({
      name: "KOBE_SKILL_MIRROR_TOKEN",
      valueFrom: { secretKeyRef: { name: "mirror-token", key: "pat", optional: true } },
    });
    expect(mirrorEnv(envOf(ms, "kobe-server"))[0]).toEqual({
      name: "KOBE_SKILL_MIRROR_USERNAME",
      value: "kobe-bot",
    });
    for (const other of ["kobe-scheduler", "kobe-egress-proxy", "kobe-mcp-proxy", "kobe-web"])
      expect(mirrorEnv(envOf(ms, other)), other).toEqual([]);
  });

  it("refuses a bad Secret name or user name (schema)", () => {
    expect(() => render({ "server.skillMirror.tokenSecret.name": "Bad_Name" })).toThrow();
    expect(() => render({ "server.skillMirror.username": "a b" })).toThrow();
  });
});
