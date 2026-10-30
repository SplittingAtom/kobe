import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// Render tests for the scheduler runner (KOBE-174): replicas > 1, the settings and the sandbox
// provider's config and keys it now needs, and the secrets it still must not get.

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

type Env = { name: string; value?: string; valueFrom?: unknown };
type Manifest = { kind: string; metadata: { name: string }; [k: string]: any };

function render(values: Record<string, string> = {}, files: readonly string[] = []): Manifest[] {
  const args = Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
  const valueFiles = files.flatMap((f) => ["-f", f]);
  const out = execFileSync(
    HELM,
    ["template", "kobe", CHART_DIR, "-n", "kobe", ...valueFiles, ...args],
    {
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  return parseAllDocuments(out)
    .map((d) => d.toJS() as Manifest | null)
    .filter((d): d is Manifest => d !== null);
}

const scheduler = (ms: Manifest[]) =>
  ms.find((m) => m.kind === "Deployment" && m.metadata.name === "kobe-scheduler");
const envOf = (ms: Manifest[]): Env[] => scheduler(ms)?.spec.template.spec.containers[0].env ?? [];
const value = (env: Env[], name: string) => env.find((e) => e.name === name)?.value;

describe("scheduler runner chart (KOBE-174)", () => {
  it("renders with three replicas and passes the runner's settings", () => {
    const ms = render({
      "scheduler.replicas": "3",
      "scheduler.tickSeconds": "30",
      "scheduler.catchUpGraceMinutes": "120",
    });
    expect(scheduler(ms)?.spec.replicas).toBe(3);
    expect(value(envOf(ms), "KOBE_SCHEDULER_TICK_SECONDS")).toBe("30");
    expect(value(envOf(ms), "KOBE_SCHEDULER_GRACE_MINUTES")).toBe("120");
  });

  it("defaults to a 15 s tick and a 60 minute grace window", () => {
    const env = envOf(render());
    expect(value(env, "KOBE_SCHEDULER_TICK_SECONDS")).toBe("15");
    expect(value(env, "KOBE_SCHEDULER_GRACE_MINUTES")).toBe("60");
  });

  // KOBE-181: the k3d e2e (dev/values.yaml) observes scheduled runs it pulls due, so it ticks at the
  // chart's minimum; production keeps the 15 s default above.
  it("ticks every 5 s with the dev/e2e values", () => {
    const devValues = fileURLToPath(new URL("../../../dev/values.yaml", import.meta.url));
    const env = envOf(render({}, [devValues]));
    expect(value(env, "KOBE_SCHEDULER_TICK_SECONDS")).toBe("5");
    expect(value(env, "KOBE_SCHEDULER_GRACE_MINUTES")).toBe("60");
  });

  it("rejects settings out of range", () => {
    expect(() => render({ "scheduler.tickSeconds": "1" })).toThrow();
    expect(() => render({ "scheduler.catchUpGraceMinutes": "0" })).toThrow();
    expect(() => render({ "scheduler.replicas": "0" })).toThrow();
  });

  it("gets the sandbox config but no session key, approval key or auth secret", () => {
    const names = envOf(render()).map((e) => e.name);
    expect(names).toContain("KOBE_SANDBOX_CONFIG");
    expect(names.filter((n) => n.startsWith("KOBE_SESSION_"))).toEqual([]);
    for (const forbidden of ["KOBE_APPROVAL_KEY", "KOBE_AUTH_SECRET", "KOBE_SETUP_TOKEN"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("still gives the server the approval key", () => {
    const server = render().find(
      (m) => m.kind === "Deployment" && m.metadata.name === "kobe-server",
    );
    const names = server?.spec.template.spec.containers[0].env.map((e: Env) => e.name);
    expect(names).toContain("KOBE_APPROVAL_KEY");
  });
});
