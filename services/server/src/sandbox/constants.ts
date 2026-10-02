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
export const BOOTSTRAP_TOKEN_DIR = "/var/run/secrets/kobe";
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

/** Pod Security Admission level enforced on team namespaces. */
export const POD_SECURITY_LEVEL = "restricted";
/** UID/GID of the `kobe` user in images/sandbox/Dockerfile. */
export const SANDBOX_UID = 1000;
