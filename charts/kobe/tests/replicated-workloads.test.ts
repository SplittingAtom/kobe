import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// KOBE-515: every workload whose replicas can exceed 1 gets a PodDisruptionBudget (minAvailable 1)
// and a soft topology spread over nodes, only while replicas > 1, each with a values switch.

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

function render(values: Record<string, string> = {}): Manifest[] {
  return parseAllDocuments(helm(values))
    .map((d) => d.toJS() as Manifest | null)
    .filter((d): d is Manifest => d !== null);
}

function renderError(values: Record<string, string>): string {
  try {
    helm(values);
  } catch (e) {
    return String((e as { stderr?: string }).stderr ?? e);
  }
  throw new Error("expected the render to fail");
}

const find = (ms: Manifest[], kind: string, name: string) =>
  ms.find((m) => m.kind === kind && m.metadata.name === name);
const spreadOf = (ms: Manifest[], component: string) =>
  find(ms, "Deployment", `kobe-${component}`)?.spec.template.spec.topologySpreadConstraints;
const selector = (component: string) => ({
  "app.kubernetes.io/name": "kobe",
  "app.kubernetes.io/instance": "kobe",
  "app.kubernetes.io/component": component,
});

// [values key, component name]
const WORKLOADS = [
  ["web", "web"],
  ["server", "server"],
  ["scheduler", "scheduler"],
  ["mcpProxy", "mcp-proxy"],
  ["egressProxy", "egress-proxy"],
  ["modelGateway", "model-gateway"],
] as const;
const scaled = Object.fromEntries(WORKLOADS.map(([key]) => [`${key}.replicas`, "3"]));

describe("replicated workloads (KOBE-515)", () => {
  it("defaults: only server and model-gateway (2 replicas) get a PDB and a spread", () => {
    const ms = render();
    const pdbs = ms.filter((m) => m.kind === "PodDisruptionBudget").map((m) => m.metadata.name);
    expect(pdbs.sort()).toEqual(["kobe-model-gateway", "kobe-server"]);
    for (const c of ["web", "scheduler", "mcp-proxy", "egress-proxy"]) {
      expect(spreadOf(ms, c)).toBeUndefined();
    }
    expect(spreadOf(ms, "server")).toBeDefined();
    expect(spreadOf(ms, "model-gateway")).toBeDefined();
    // Bifrost is single by design (schema maximum 1): no PDB, no spread.
    expect(find(ms, "PodDisruptionBudget", "kobe-bifrost")).toBeUndefined();
    expect(spreadOf(ms, "bifrost")).toBeUndefined();
  });

  it.each(WORKLOADS)("%s scaled: PDB minAvailable 1 on its selector labels", (_key, c) => {
    const pdb = find(render(scaled), "PodDisruptionBudget", `kobe-${c}`);
    expect(pdb?.apiVersion).toBe("policy/v1");
    expect(pdb?.spec).toEqual({ minAvailable: 1, selector: { matchLabels: selector(c) } });
  });

  it.each(WORKLOADS)("%s scaled: soft spread over nodes on its selector labels", (_key, c) => {
    expect(spreadOf(render(scaled), c)).toEqual([
      {
        maxSkew: 1,
        topologyKey: "kubernetes.io/hostname",
        whenUnsatisfiable: "ScheduleAnyway",
        labelSelector: { matchLabels: selector(c) },
        matchLabelKeys: ["pod-template-hash"],
      },
    ]);
  });

  it.each(WORKLOADS.filter(([key]) => key !== "server"))(
    "%s at replicas 1: no PDB, no spread",
    (key, c) => {
      const ms = render({ ...scaled, [`${key}.replicas`]: "1" });
      expect(find(ms, "PodDisruptionBudget", `kobe-${c}`)).toBeUndefined();
      expect(spreadOf(ms, c)).toBeUndefined();
    },
  );

  it("server never drops to one replica (schema, spec D2), so its PDB never blocks a drain", () => {
    expect(renderError({ "server.replicas": "1" })).toMatch(/server\/replicas/);
  });

  it.each(WORKLOADS)("%s: each switch turns its part off", (key, c) => {
    const noPdb = render({ ...scaled, [`${key}.podDisruptionBudget.enabled`]: "false" });
    expect(find(noPdb, "PodDisruptionBudget", `kobe-${c}`)).toBeUndefined();
    expect(spreadOf(noPdb, c)).toBeDefined();
    const noSpread = render({ ...scaled, [`${key}.topologySpread.enabled`]: "false" });
    expect(spreadOf(noSpread, c)).toBeUndefined();
    expect(find(noSpread, "PodDisruptionBudget", `kobe-${c}`)).toBeDefined();
  });

  it("takes a topologyKey override", () => {
    const ms = render({ "server.topologySpread.topologyKey": "topology.kubernetes.io/zone" });
    expect(spreadOf(ms, "server")?.[0].topologyKey).toBe("topology.kubernetes.io/zone");
  });

  it("schema: validates the new keys", () => {
    expect(renderError({ "server.podDisruptionBudget.enabled": "maybe" })).toMatch(/enabled/);
    expect(renderError({ "web.topologySpread.bogus": "1" })).toMatch(/additional properties/i);
    expect(renderError({ "modelGateway.topologySpread.topologyKey": "" })).toMatch(/topologyKey/);
    expect(renderError({ "bifrost.podDisruptionBudget.enabled": "true" })).toMatch(
      /additional properties/i,
    );
  });
});
