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

function render(
  values: Record<string, string> = {},
  {
    release = "kobe",
    namespace = "kobe",
    upgrade = false,
  }: { release?: string; namespace?: string; upgrade?: boolean } = {},
): Manifest[] {
  const out = execFileSync(
    HELM,
    [
      "template",
      release,
      CHART_DIR,
      "-n",
      namespace,
      ...(upgrade ? ["--is-upgrade"] : []),
      ...helmArgs(values),
    ],
    { encoding: "utf8" },
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

  const HOOKS = "pre-install,pre-upgrade,pre-rollback";
  const hooked = (kind: string) => ms.filter((m) => m.kind === kind && hook(m) === HOOKS);

  it("runs as a pre-install/pre-upgrade/pre-rollback hook Job checking the configured class", () => {
    const job = find(ms, "Job", "kobe-isolation-preflight");
    expect(job && hook(job)).toBe(HOOKS);
    expect(job?.spec.backoffLimit).toBe(0);
    const c = job?.spec.template.spec.containers[0];
    expect(c.command).toEqual(["node", "dist/cli/preflight.js"]);
    expect(c.env).toContainEqual({ name: "KOBE_RUNTIME_CLASS", value: "gvisor" });
  });

  it("creates its least-privilege RBAC before the Job", () => {
    const job = find(ms, "Job", "kobe-isolation-preflight")!;
    const [role] = hooked("ClusterRole");
    expect(role?.rules).toEqual([
      { apiGroups: ["node.k8s.io"], resources: ["runtimeclasses"], verbs: ["get", "list"] },
    ]);
    for (const m of [role!, hooked("ClusterRoleBinding")[0]!, hooked("ServiceAccount")[0]!]) {
      expect(weight(m), m.kind).toBeLessThan(weight(job));
    }
  });

  it("gates the server and scheduler with a preflight initContainer (Helm flags can't skip it)", () => {
    for (const name of ["kobe-server", "kobe-scheduler"]) {
      const spec = find(ms, "Deployment", name)?.spec.template.spec;
      expect(spec.serviceAccountName, name).toBe("kobe-server");
      expect(spec.initContainers[0], name).toEqual(
        expect.objectContaining({
          name: "isolation-preflight",
          command: ["node", "dist/cli/preflight.js"],
          env: [{ name: "KOBE_RUNTIME_CLASS", value: "gvisor" }],
        }),
      );
    }
  });

  it("uses collision-proof cluster-scoped names per release and namespace", () => {
    const clusterNames = (release: string, namespace: string) =>
      render({}, { release, namespace })
        .filter((m) => m.kind.startsWith("ClusterRole"))
        .map((m) => m.metadata.name);
    const a = clusterNames("a-b", "c");
    const b = clusterNames("a", "b-c");
    expect(a.length).toBeGreaterThan(0);
    expect(a.filter((n) => b.includes(n))).toEqual([]);
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

describe("migrations (KOBE-68)", () => {
  const hook = (m: Manifest | undefined) => m?.metadata.annotations?.["helm.sh/hook"];
  const weight = (m: Manifest | undefined) =>
    Number(m?.metadata.annotations?.["helm.sh/hook-weight"]);
  const migrateEnv = (ms: Manifest[]) =>
    find(ms, "Job", "kobe-migrate")?.spec.template.spec.containers[0].env as unknown[];

  it("external: migrates as the owner in a pre-install/pre-upgrade hook after the isolation preflight", () => {
    const ms = render();
    const job = find(ms, "Job", "kobe-migrate");
    expect(hook(job)).toBe("pre-install,pre-upgrade");
    expect(weight(job)).toBeGreaterThan(weight(find(ms, "Job", "kobe-isolation-preflight")));
    expect(job?.spec.backoffLimit).toBe(0);
    const c = job?.spec.template.spec.containers[0];
    expect(c.image).toBe("ghcr.io/splittingatom/kobe-server:0.1.0");
    expect(c.command).toEqual(["node", "node_modules/@kobe/db/dist/cli/migrate.js"]);
    expect(migrateEnv(ms)).toEqual(
      expect.arrayContaining([
        {
          name: "KOBE_DB_MIGRATE_URL",
          valueFrom: { secretKeyRef: { name: "kobe-db", key: "migrate-url" } },
        },
        { name: "KOBE_DB_APP_ROLE", value: "kobe_app" },
      ]),
    );
    expect(job?.spec.template.spec.automountServiceAccountToken).toBe(false);
  });

  it("defaults keys added after a release so `helm upgrade --reuse-values` keeps working", () => {
    expect(migrateEnv(render({ "postgres.external.appRole": "null" }))).toContainEqual({
      name: "KOBE_DB_APP_ROLE",
      value: "kobe_app",
    });
  });

  it("cnpg first install: migrates in an ordinary Job (post-install hooks would deadlock --wait)", () => {
    const ms = render({ "postgres.mode": "cnpg" });
    const initial = find(ms, "Job", "kobe-migrate-initial");
    expect(initial).toBeDefined();
    expect(hook(initial)).toBeUndefined();
    expect(find(ms, "Job", "kobe-migrate")).toBeUndefined();
    expect(initial?.spec.template.spec.containers[0].env).toContainEqual({
      name: "KOBE_DB_MIGRATE_URL",
      valueFrom: { secretKeyRef: { name: "kobe-pg-app", key: "uri" } },
    });
  });

  it("cnpg upgrade: migrates in a pre-upgrade hook before new pods roll", () => {
    const ms = render({ "postgres.mode": "cnpg" }, { upgrade: true });
    expect(hook(find(ms, "Job", "kobe-migrate"))).toBe("pre-upgrade");
    expect(find(ms, "Job", "kobe-migrate-initial")).toBeUndefined();
  });

  it("mounts owner credentials only in the migration Job", () => {
    for (const values of [{}, { "postgres.mode": "cnpg" }]) {
      const ms = render(values);
      const owners = podSpecs(ms)
        .filter(({ spec }) =>
          JSON.stringify(spec).match(/"key":"migrate-url"|"name":"kobe-pg-app"/),
        )
        .map(({ name }) => name);
      expect(owners).toHaveLength(1);
      expect(owners[0]).toMatch(/^Job\/kobe-migrate(-initial)?$/);
    }
  });

  it("holds server and scheduler pods until this build's migrations are applied (app role)", () => {
    const ms = render();
    for (const name of ["kobe-server", "kobe-scheduler"]) {
      const wait = find(ms, "Deployment", name)?.spec.template.spec.initContainers[1];
      expect(wait?.name, name).toBe("wait-for-migrations");
      expect(wait?.command).toEqual(["node", "node_modules/@kobe/db/dist/cli/wait.js"]);
      expect(wait?.env).toContainEqual({
        name: "KOBE_DATABASE_URL",
        valueFrom: { secretKeyRef: { name: "kobe-db", key: "app-url" } },
      });
    }
  });
});

describe("least privilege between components", () => {
  it("gives mcp-proxy no database credentials (it sits at the sandbox boundary)", () => {
    const env =
      find(render(), "Deployment", "kobe-mcp-proxy")?.spec.template.spec.containers[0].env ?? [];
    expect(env.map((e: { name: string }) => e.name)).not.toContain("KOBE_DATABASE_URL");
  });

  it("refuses an app connection URL key equal to the owner/migration key", () => {
    expect(renderError({ "postgres.external.appUrlKey": "migrate-url" })).toMatch(/owner/);
  });

  it("keeps a server replica available during voluntary disruptions", () => {
    expect(find(render(), "PodDisruptionBudget", "kobe-server")?.spec).toMatchObject({
      minAvailable: 1,
    });
  });
});

describe("network policies", () => {
  const ms = render({ "postgres.mode": "cnpg", "clamav.enabled": "true" });
  const policy = (name: string) => find(ms, "NetworkPolicy", name);

  it("lets only pods in the release namespace reach Bifrost (provider keys) and ClamAV", () => {
    for (const name of ["kobe-bifrost", "kobe-clamav"]) {
      expect(policy(name)?.spec.policyTypes, name).toEqual(["Ingress"]);
      expect(policy(name)?.spec.ingress, name).toEqual([{ from: [{ podSelector: {} }] }]);
    }
  });

  it("lets only the release namespace and the CloudNativePG operator reach Postgres", () => {
    expect(policy("kobe-pg")?.spec.podSelector).toEqual({
      matchLabels: { "cnpg.io/cluster": "kobe-pg" },
    });
    expect(policy("kobe-pg")?.spec.ingress).toEqual([
      { from: [{ podSelector: {} }] },
      {
        from: [
          { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "cnpg-system" } } },
        ],
      },
    ]);
  });
});

describe("CloudNativePG app credentials", () => {
  it("rolls pods when the generated app password changes", () => {
    const ms = render({ "postgres.mode": "cnpg" });
    const annotations =
      find(ms, "Deployment", "kobe-server")?.spec.template.metadata.annotations ?? {};
    expect(annotations["checksum/db-app"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses a pre-created app Secret instead of generating one (GitOps-safe)", () => {
    const ms = render({
      "postgres.mode": "cnpg",
      "postgres.cnpg.existingAppSecret": "my-app-login",
    });
    expect(find(ms, "Secret", "kobe-db-app")).toBeUndefined();
    expect(find(ms, "Cluster", "kobe-pg")?.spec.managed.roles[0].passwordSecret).toEqual({
      name: "my-app-login",
    });
    const env = find(ms, "Deployment", "kobe-server")?.spec.template.spec.containers[0].env;
    expect(env).toContainEqual({
      name: "KOBE_DB_PASSWORD",
      valueFrom: { secretKeyRef: { name: "my-app-login", key: "password" } },
    });
  });
});

describe("ClamAV", () => {
  it("is off by default and optional", () => {
    expect(find(render(), "Deployment", "kobe-clamav")).toBeUndefined();
    expect(find(render({ "clamav.enabled": "true" }), "Deployment", "kobe-clamav")).toBeDefined();
  });
});
