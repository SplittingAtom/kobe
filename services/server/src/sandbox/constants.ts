/**
 * Names and labels shared by the sandbox provider, the chart (templates/sandbox-*.yaml) and the
 * e2e suite. A chart render test keeps the chart's copies equal to these.
 */

/** Spec D11: one namespace per team, `kobe-team-<slug>` (slug ≤ 32 chars, so ≤ 42 chars). */
export const TEAM_NAMESPACE_PREFIX = "kobe-team-";

const DOMAIN = "kobe.splittingatom.io";
/** On every team namespace; the Bifrost NetworkPolicy admits sandboxes by it. */
export const LABEL_TEAM_NAMESPACE = `${DOMAIN}/team-namespace`;
/** Team id on the namespace: a namespace whose label names another team is never reused. */
export const LABEL_TEAM_ID = `${DOMAIN}/team-id`;
/** User id on a SandboxClaim (label, for listing) and on its pod (annotation, for operators). */
export const LABEL_USER_ID = `${DOMAIN}/user-id`;
export const ANNOTATION_TEAM_ID = LABEL_TEAM_ID;
export const ANNOTATION_USER_ID = LABEL_USER_ID;
export const LABEL_MANAGED_BY = "app.kubernetes.io/managed-by";
export const MANAGED_BY = "kobe-server";

/** Pod label the agent-sandbox claim controller sets to the owning claim's UID. */
export const LABEL_CLAIM_UID = "agents.x-k8s.io/claim-uid";

/** Objects the provider keeps in every team namespace. */
export const SANDBOX_SERVICE_ACCOUNT = "kobe-sandbox";
export const SANDBOX_TEMPLATE = "kobe-sandbox";
export const SANDBOX_WARM_POOL = "kobe-sandbox";
export const NETWORK_POLICY = "kobe-sandbox-isolation";
export const RESOURCE_QUOTA = "kobe-team-quota";
export const LIMIT_RANGE = "kobe-sandbox-defaults";
export const SERVER_ROLE_BINDING = "kobe-server";
export const SANDBOX_CONTAINER = "agent";

/**
 * Audience of the projected ServiceAccount token in each sandbox pod. The pod trades it at the
 * server (POST /v1/sandbox/session, verified with a TokenReview) for its audience-bound session
 * tokens. The Kubernetes API rejects tokens with this audience, so it grants no API access.
 */
export const BOOTSTRAP_TOKEN_AUDIENCE = "kobe.sandbox-bootstrap";
/**
 * Under the image's agent-only directory (`/run/kobe-agent`, 0700, KOBE-71): the projected file
 * itself is group-readable by the pod's fsGroup, which every Pi identity shares (the workspace
 * group), so only the parent keeps sandbox code out.
 */
export const BOOTSTRAP_TOKEN_DIR = "/run/kobe-agent/bootstrap";
export const BOOTSTRAP_TOKEN_FILE = `${BOOTSTRAP_TOKEN_DIR}/bootstrap-token`;
/** Kubelet refreshes the projected token at 80% of this lifetime. */
export const BOOTSTRAP_TOKEN_SECONDS = 3600;

/**
 * Hostnames sandboxes use for Kobe's services. They resolve through /etc/hosts (pod hostAliases
 * pointing at the Services' ClusterIPs): sandboxes get no DNS at all, so DNS cannot be used as an
 * exfiltration channel around the default-deny egress policy. `.internal` is reserved for private use.
 */
export const SANDBOX_HOSTS = {
  server: "server.kobe.internal",
  modelGateway: "model-gateway.kobe.internal",
  mcpProxy: "mcp-proxy.kobe.internal",
  egressProxy: "egress-proxy.kobe.internal",
} as const;
export type KobeEndpoint = keyof typeof SANDBOX_HOSTS;
export const KOBE_ENDPOINTS = Object.keys(SANDBOX_HOSTS) as KobeEndpoint[];

/**
 * Pod Security Admission level enforced on team namespaces. "baseline", not "restricted", for
 * one reason only (KOBE-71): the sandbox container adds the SETUID and SETGID capabilities and
 * allows privilege escalation, so the image's kobe-runas helper can start each Pi process under
 * its own uid. Everything else "restricted" demands (non-root, seccomp, drop ALL, volume types)
 * is enforced by Kobe's own admission policy for team pods (chart: sandbox-admission.yaml).
 */
export const POD_SECURITY_LEVEL = "baseline";
/** UID/GID of the `kobe` user in images/sandbox/Dockerfile (the agent; the workspace group). */
export const SANDBOX_UID = 1000;
/** Group `kobe-agent` in the image: the only group allowed to execute kobe-runas (KOBE-71). */
export const SANDBOX_AGENT_GID = 1001;
/** First Pi identity (`kobe-pi-0`, uid = gid) in the image; kobe-runas accepts 2000-2063. */
export const PI_IDENTITY_BASE = 2000;
/**
 * Pi identities per sandbox: more than the agent's Pi process cap (8 by default) so a new Pi need
 * not wait while an exited one's identity is being reclaimed.
 */
export const PI_IDENTITIES = 16;
/**
 * Where each Pi process gets its private runtime directory (KOBE-71): a memory-backed emptyDir,
 * because its root is sticky (3777) and a mount point, so no Pi identity can rename the agent's
 * directories in it (on the disk-backed /tmp, 2777, any of them could). Small: Pi keeps only its
 * credential and catalog stores and the model file there.
 */
export const PI_RUNTIME_DIR = "/run/kobe-pi";
export const PI_RUNTIME_SIZE = "64Mi";
/**
 * Where kobe-sandbox-agent materializes a run's effective skills (KOBE-82): a second memory-backed
 * emptyDir for the same reason as PI_RUNTIME_DIR (sticky root no Pi identity can rename in), so
 * the agent's read-only skill directories can't be swapped by a tool. Sized for the agent's cap
 * (96 MiB across all live threads' skills, services/sandbox-agent skills/store.ts).
 */
export const SKILLS_DIR = "/run/kobe-skills";
export const SKILLS_SIZE = "128Mi";
/** The helper that starts Pi under its identity (images/sandbox/runas). */
export const PI_RUNAS_HELPER = "/opt/kobe/bin/kobe-runas";
/** The only capabilities a sandbox container adds (after dropping ALL), for kobe-runas. */
export const SANDBOX_CAPABILITIES = ["SETUID", "SETGID"] as const;
