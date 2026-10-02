import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { ISOLATION_REMEDIATION } from "../../../services/server/src/isolation/runtime-class.js";

const CHART_DIR = fileURLToPath(new URL("..", import.meta.url));
const HELM = process.env.HELM_BIN ?? "helm";

/** Minimal values a real install must provide (external Postgres + S3, ingress host, pull secret). */
const BASE: Record<string, string> = {
  "ingress.host": "kobe.example.com",
  "postgres.external.existingSecret": "kobe-db",
  "s3.endpoint": "https://s3.example.com",
  "s3.bucket": "kobe",
  "s3.existingSecret": "kobe-s3",
  "global.imagePullSecrets[0].name": "ghcr-pull",
};

type Manifest = {
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  spec?: any;
};

function helmArgs(values: Record<string, string>): string[] {
  return Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
}

function render(values: Record<string, string> = {}): Manifest[] {
  const out = execFileSync(
    HELM,
    ["template", "kobe", CHART_DIR, "-n", "kobe", ...helmArgs(values)],
    {
      encoding: "utf8",
    },
  );
  return parseAllDocuments(out)
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
}

function renderError(values: Record<string, string>, unset: string[] = []): string {
  const base = Object.fromEntries(Object.entries(BASE).filter(([k]) => !unset.includes(k)));
  const args = Object.entries({ ...base, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
  try {
    execFileSync(HELM, ["template", "kobe", CHART_DIR, "-n", "kobe", ...args], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
  throw new Error(`expected helm template to fail for ${JSON.stringify(values)}`);
}

const byKind = (ms: Manifest[], kind: string) => ms.filter((m) => m.kind === kind);
const find = (ms: Manifest[], kind: string, name: string) =>
  ms.find((m) => m.kind === kind && m.metadata.name === name);
const podSpecs = (ms: Manifest[]) =>
  ms
    .filter((m) => ["Deployment", "StatefulSet", "Job", "DaemonSet"].includes(m.kind))
    .map((m) => ({ name: `${m.kind}/${m.metadata.name}`, spec: m.spec.template.spec }));

describe("workloads", () => {
  const ms = render();

  it("deploys web, server, mcp-proxy, egress-proxy, scheduler and Bifrost", () => {
    expect(
      byKind(ms, "Deployment")
        .map((d) => d.metadata.name)
        .sort(),
    ).toEqual(
      [
        "kobe-bifrost",
        "kobe-egress-proxy",
        "kobe-mcp-proxy",
        "kobe-scheduler",
        "kobe-server",
        "kobe-web",
      ].sort(),
    );
  });

  it("runs at least two server replicas", () => {
    expect(find(ms, "Deployment", "kobe-server")?.spec.replicas).toBeGreaterThanOrEqual(2);
    expect(renderError({ "server.replicas": "1" })).toMatch(/replicas/);
  });

  it("runs the scheduler as the server image in scheduler mode", () => {
    const c = find(ms, "Deployment", "kobe-scheduler")?.spec.template.spec.containers[0];
    expect(c.image).toBe("ghcr.io/splittingatom/kobe-server:0.1.0");
    expect(c.env).toContainEqual({ name: "KOBE_PROCESS", value: "scheduler" });
  });

  it("defaults images to the private registry and the chart appVersion", () => {
    expect(find(ms, "Deployment", "kobe-web")?.spec.template.spec.containers[0].image).toBe(
      "ghcr.io/splittingatom/kobe-web:0.1.0",
    );
  });

  it("applies global.imagePullSecrets to every pod (ac-3)", () => {
    for (const { name, spec } of podSpecs(ms)) {
      expect(spec.imagePullSecrets, name).toEqual([{ name: "ghcr-pull" }]);
    }
  });

  it("runs every pod non-root with a hardened container security context", () => {
    for (const { name, spec } of podSpecs(ms)) {
      expect(spec.securityContext?.runAsNonRoot, name).toBe(true);
      expect(spec.securityContext?.seccompProfile, name).toEqual({ type: "RuntimeDefault" });
      for (const c of [...spec.containers, ...(spec.initContainers ?? [])]) {
        expect(c.securityContext, `${name}/${c.name}`).toMatchObject({
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ["ALL"] },
        });
      }
    }
  });
});

describe("isolation preflight (ac-2)", () => {
  const ms = render();
  const hook = (m: Manifest) => m.metadata.annotations?.["helm.sh/hook"];
  const weight = (m: Manifest) => Number(m.metadata.annotations?.["helm.sh/hook-weight"] ?? 0);

  it("runs as a pre-install/pre-upgrade hook Job that can't be retried into success", () => {
    const job = find(ms, "Job", "kobe-isolation-preflight");
    expect(job && hook(job)).toBe("pre-install,pre-upgrade");
    expect(job?.spec.backoffLimit).toBe(0);
    expect(job?.spec.template.spec.containers[0].command).toEqual([
      "node",
      "dist/cli/preflight.js",
    ]);
  });

  it("creates its least-privilege RBAC before the Job", () => {
    const job = find(ms, "Job", "kobe-isolation-preflight")!;
    const role = find(ms, "ClusterRole", "kobe-kobe-isolation-preflight")!;
    expect(role.rules).toEqual([
      { apiGroups: ["node.k8s.io"], resources: ["runtimeclasses"], verbs: ["get", "list"] },
    ]);
    for (const m of [
      role,
      find(ms, "ClusterRoleBinding", "kobe-kobe-isolation-preflight")!,
      find(ms, "ServiceAccount", "kobe-isolation-preflight")!,
    ]) {
      expect(hook(m), m.kind).toBe("pre-install,pre-upgrade");
      expect(weight(m), m.kind).toBeLessThan(weight(job));
    }
  });

  it("cannot be disabled (no isolation bypass)", () => {
    expect(renderError({ "isolation.preflight.enabled": "false" })).toMatch(
      /additional properties|preflight/i,
    );
  });

  it("uses the same remediation text as the server's startup check", () => {
    const template = readFileSync(`${CHART_DIR}/templates/_isolation.tpl`, "utf8");
    expect(template).toContain(ISOLATION_REMEDIATION);
  });
});

describe("values.schema.json (ac-3)", () => {
  it("rejects unknown keys at every level", () => {
    expect(renderError({ bogus: "1" })).toMatch(/additional properties/i);
    expect(renderError({ "server.bogus": "1" })).toMatch(/additional properties/i);
  });

  it("requires an ingress host when ingress is enabled", () => {
    expect(renderError({}, ["ingress.host"])).toMatch(/host/);
  });

  it("requires external Postgres credentials unless CloudNativePG is bundled", () => {
    expect(renderError({}, ["postgres.external.existingSecret"])).toMatch(/existingSecret/);
    expect(renderError({ "postgres.mode": "sqlite" })).toMatch(/mode/);
  });

  it("requires an external S3 endpoint, bucket and credentials (no bundled S3)", () => {
    expect(renderError({}, ["s3.endpoint"])).toMatch(/endpoint/);
    expect(renderError({}, ["s3.existingSecret"])).toMatch(/existingSecret/);
    expect(renderError({ "minio.enabled": "true" })).toMatch(/additional properties/i);
  });
});

describe("Postgres modes (ac-1)", () => {
  it("external: reads the app connection URL from the provided Secret", () => {
    const ms = render();
    const env = find(ms, "Deployment", "kobe-server")?.spec.template.spec.containers[0].env;
    expect(env).toContainEqual({
      name: "KOBE_DATABASE_URL",
      valueFrom: { secretKeyRef: { name: "kobe-db", key: "app-url" } },
    });
    expect(byKind(ms, "Cluster")).toEqual([]);
  });

  it("cnpg: bundles a CloudNativePG Cluster with a separate non-owner app role", () => {
    const ms = render({ "postgres.mode": "cnpg" });
    const cluster = find(ms, "Cluster", "kobe-pg");
    expect(cluster?.spec.bootstrap.initdb).toMatchObject({ database: "kobe", owner: "kobe_owner" });
    expect(cluster?.spec.managed.roles).toEqual([
      expect.objectContaining({
        name: "kobe_app",
        login: true,
        superuser: false,
        bypassrls: false,
        createdb: false,
        createrole: false,
        inRoles: [],
        passwordSecret: { name: "kobe-db-app" },
      }),
    ]);
    expect(cluster?.spec.imagePullSecrets).toEqual([{ name: "ghcr-pull" }]);
    const env = find(ms, "Deployment", "kobe-server")?.spec.template.spec.containers[0].env;
    expect(env).toContainEqual({
      name: "KOBE_DATABASE_URL",
      value: "postgres://kobe_app:$(KOBE_DB_PASSWORD)@kobe-pg-rw:5432/kobe",
    });
    expect(find(ms, "Secret", "kobe-db-app")?.type).toBe("kubernetes.io/basic-auth");
  });
});

describe("ingress", () => {
  it("routes the host through Traefik with cert-manager TLS", () => {
    const ms = render({ "ingress.tls.clusterIssuer": "letsencrypt" });
    const ing = find(ms, "Ingress", "kobe");
    expect(ing?.spec.ingressClassName).toBe("traefik");
    expect(ing?.metadata.annotations?.["cert-manager.io/cluster-issuer"]).toBe("letsencrypt");
    expect(ing?.spec.tls).toEqual([{ hosts: ["kobe.example.com"], secretName: "kobe-tls" }]);
    const paths = ing?.spec.rules[0].http.paths.map((p: any) => [p.path, p.backend.service.name]);
    expect(paths).toEqual([
      ["/v1", "kobe-server"],
      ["/", "kobe-web"],
    ]);
  });
});

describe("ClamAV", () => {
  it("is off by default and optional", () => {
    expect(find(render(), "Deployment", "kobe-clamav")).toBeUndefined();
    expect(find(render({ "clamav.enabled": "true" }), "Deployment", "kobe-clamav")).toBeDefined();
  });
});
