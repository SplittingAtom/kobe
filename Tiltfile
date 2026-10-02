# Kobe dev loop (KOBE-7). `scripts/dev-cluster.sh && tilt up` builds every service image and deploys
# the Helm chart (plus a throwaway Postgres) into a k3d cluster with gVisor. To develop against a
# real k3s cluster instead, set KOBE_DEV_CONTEXT=<kube context> and KOBE_DEV_REGISTRY=<registry the
# cluster can pull from>. There is no docker compose.

dev_context = os.getenv("KOBE_DEV_CONTEXT", "")
if dev_context:
    allow_k8s_contexts(dev_context)
dev_registry = os.getenv("KOBE_DEV_REGISTRY", "")
if dev_registry:
    default_registry(dev_registry)

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

k8s_yaml("dev/postgres.yaml")
k8s_resource(workload="pg", labels=["deps"])

k8s_yaml(helm("charts/kobe", name="kobe", namespace="kobe", values=["dev/values.yaml"]))

for name in ["web", "server", "scheduler", "mcp-proxy", "egress-proxy", "bifrost"]:
    k8s_resource(workload="kobe-" + name, labels=["kobe"], resource_deps=["pg"] if name in ["server", "scheduler"] else [])
k8s_resource(workload="kobe-migrate", labels=["kobe"], resource_deps=["pg"])
k8s_resource(workload="kobe-isolation-preflight", labels=["kobe"])
k8s_resource(workload="kobe-web", port_forwards=["3000:8080"])
