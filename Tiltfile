# Kobe dev loop (KOBE-7). `scripts/dev-cluster.sh && tilt up` builds every service image and deploys
# the Helm chart (plus a throwaway Postgres) into a k3d cluster with gVisor. To develop against a
# real k3s cluster instead, set KOBE_DEV_CONTEXT=<kube context> and KOBE_DEV_REGISTRY=<registry the
# cluster can pull from>. There is no docker compose.

dev_context = os.getenv("KOBE_DEV_CONTEXT", "")
current = k8s_context()
local = current.startswith("k3d-")
if dev_context:
    allow_k8s_contexts(dev_context)
# allow_k8s_contexts only allows; pin the context so a stray `kubectl config use-context` can't
# point the dev loop at another cluster.
if not local and current != dev_context:
    fail("refusing to deploy to context %r: use a k3d-* context or set KOBE_DEV_CONTEXT=%s" % (current, current))
dev_registry = os.getenv("KOBE_DEV_REGISTRY", "")
if dev_registry:
    default_registry(dev_registry)
# Parallel agents each take their own namespace (kobe-dev-<ticket>) and web port; the default
# stays kobe-dev on :3000. Never the production namespace `kobe`.
NAMESPACE = os.getenv("KOBE_DEV_NAMESPACE", "kobe-dev")
if NAMESPACE != "kobe-dev" and not NAMESPACE.startswith("kobe-dev-"):
    fail("KOBE_DEV_NAMESPACE must be kobe-dev or kobe-dev-<suffix>, got %r" % NAMESPACE)
if local and NAMESPACE != "kobe-dev":
    # dev/postgres.yaml and dev/values.yaml are written for kobe-dev.
    fail("KOBE_DEV_NAMESPACE is for shared real clusters; k3d dev uses kobe-dev")
WEB_PORT = os.getenv("KOBE_DEV_WEB_PORT", "3000")

update_settings(max_parallel_updates=2, k8s_upsert_timeout_secs=300)

REGISTRY = "ghcr.io/splittingatom"
# Every workspace manifest must be in each build context (pnpm --frozen-lockfile checks all
# importers); sources are limited to the service being built plus shared packages.
MANIFESTS = [
    "apps/web/package.json",
    "services/server/package.json",
    "services/sandbox-agent/package.json",
    "services/mcp-proxy/package.json",
    "services/egress-proxy/package.json",
    "tools/license-check/package.json",
    "charts/kobe/package.json",
]
COMMON = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "turbo.json", "tsconfig.base.json", "packages"] + MANIFESTS

def kobe_image(name, dockerfile, sources):
    docker_build(
        "%s/kobe-%s" % (REGISTRY, name),
        context=".",
        dockerfile=dockerfile,
        only=COMMON + sources,
        ignore=["**/node_modules", "**/dist", "**/.next", "**/*.test.ts"],
    )

kobe_image("web", "apps/web/Dockerfile", ["apps/web"])
kobe_image("server", "services/server/Dockerfile", ["services/server"])
kobe_image("mcp-proxy", "services/mcp-proxy/Dockerfile", ["services/mcp-proxy"])
kobe_image("egress-proxy", "services/egress-proxy/Dockerfile", ["services/egress-proxy"])

if local:
    # Throwaway Postgres with public dev credentials: k3d only.
    k8s_yaml("dev/postgres.yaml")
    k8s_resource(workload="pg", labels=["deps"])
    values = ["dev/values.yaml"]
    deps = ["pg"]
else:
    # Real cluster: bring your own values (database, S3, ingress) in KOBE_DEV_VALUES.
    values_file = os.getenv("KOBE_DEV_VALUES", "")
    if not values_file:
        fail("set KOBE_DEV_VALUES to a values file for context %r (dev/values.yaml is k3d-only)" % current)
    values = [values_file]
    deps = []

k8s_yaml(helm("charts/kobe", name="kobe", namespace=NAMESPACE, values=values))

for name in ["web", "server", "scheduler", "mcp-proxy", "egress-proxy", "bifrost"]:
    k8s_resource(workload="kobe-" + name, labels=["kobe"], resource_deps=deps if name in ["server", "scheduler"] else [])
k8s_resource(workload="kobe-migrate", labels=["kobe"], resource_deps=deps)
k8s_resource(workload="kobe-isolation-preflight", labels=["kobe"])
k8s_resource(workload="kobe-web", port_forwards=["%s:8080" % WEB_PORT])
