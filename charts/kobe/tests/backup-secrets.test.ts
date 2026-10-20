import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// KOBE-425: every Secret the chart generates holds key material a restore may need, so
// docs/backup-restore.md ("Secrets") must list each one, with the values key that reuses it.
// A new generated Secret fails here until the table names it.

const CHART_DIR = fileURLToPath(new URL("..", import.meta.url));
const DOC = fileURLToPath(new URL("../../../docs/backup-restore.md", import.meta.url));
const HELM = process.env.HELM_BIN ?? "helm";
const BASE: Record<string, string> = {
  "ingress.host": "kobe.example.com",
  "s3.endpoint": "https://s3.example.com",
  "s3.bucket": "kobe",
  "s3.existingSecret": "kobe-s3",
  "smtp.host": "smtp.example.com",
  "smtp.from": "Kobe <kobe@example.com>",
  "global.allowGeneratedSecretsOffline": "true",
};

type Manifest = { kind: string; metadata: { name: string; annotations?: Record<string, string> } };

function generatedSecrets(values: Record<string, string>): string[] {
  const args = Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
  const out = execFileSync(HELM, ["template", "kobe", CHART_DIR, "-n", "kobe", ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return parseAllDocuments(out)
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m?.kind === "Secret")
    .map((m) => m.metadata.name);
}

/** The table's rows: generated name (`<release>-…`) → its values key. */
function documented(): Map<string, string> {
  const doc = readFileSync(DOC, "utf8");
  const rows = new Map<string, string>();
  for (const m of doc.matchAll(/^\| `<release>-([a-z0-9-]+)`[^|]*\| `([A-Za-z.]+)`/gm)) {
    rows.set(`kobe-${m[1]}`, m[2] as string);
  }
  return rows;
}

/** The chart's Secrets with the row's values key given a Secret of one's own. */
function generatedWithOwn(name: string, key: string): string[] {
  return generatedSecrets({
    "postgres.external.existingSecret": "kobe-db",
    [key]: `${name}-mine`,
    ...(key.startsWith("postgres.cnpg.") ? { "postgres.mode": "cnpg" } : {}),
  });
}

describe("the Secrets a restore needs are all documented (KOBE-425)", () => {
  // Every `helm template` runs while the suite is collected, which has no per-test timeout: one
  // render per table row took over 5 s inside a single test on a loaded runner (KOBE-415).
  const rows = documented();
  const generated = [
    ...new Set([
      ...generatedSecrets({ "postgres.external.existingSecret": "kobe-db" }),
      ...generatedSecrets({ "postgres.mode": "cnpg" }),
    ]),
  ].sort();
  const withOwn = [...rows].map(([name, key]) => ({
    name,
    key,
    secrets: generatedWithOwn(name, key),
  }));

  it("finds the chart's generated Secrets (the render works)", () => {
    expect(generated).toEqual(
      expect.arrayContaining(["kobe-auth", "kobe-envelope-key", "kobe-model-keys"]),
    );
  });

  it("lists every generated Secret in docs/backup-restore.md, with its values key", () => {
    const missing = generated.filter((name) => !rows.has(name));
    expect(missing, "add these to the Secrets table in docs/backup-restore.md").toEqual([]);
  });

  it("names a values key that really replaces the generated Secret", () => {
    expect(withOwn.length).toBe(rows.size);
    // Giving the key a Secret of one's own: the chart generates no Secret of that name.
    for (const { name, key, secrets } of withOwn) {
      expect(secrets, `${key} → ${name}`).not.toContain(name);
    }
  });
});
