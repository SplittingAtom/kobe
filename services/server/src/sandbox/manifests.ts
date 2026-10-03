import type { VerifiedIsolation } from "../isolation/gate.js";
import type { SandboxSettings } from "./config.js";
import {
  ANNOTATION_TEAM_ID,
  ANNOTATION_USER_ID,
  BOOTSTRAP_TOKEN_AUDIENCE,
  BOOTSTRAP_TOKEN_DIR,
  BOOTSTRAP_TOKEN_FILE,
  BOOTSTRAP_TOKEN_SECONDS,
  KOBE_ENDPOINTS,
  LABEL_MANAGED_BY,
  LABEL_TEAM_ID,
  LABEL_TEAM_NAMESPACE,
  LABEL_USER_ID,
  LIMIT_RANGE,
  MANAGED_BY,
  NETWORK_POLICY,
  POD_SECURITY_LEVEL,
  RESOURCE_QUOTA,
  SANDBOX_CONTAINER,
  SANDBOX_HOSTS,
  SANDBOX_SERVICE_ACCOUNT,
  SANDBOX_TEMPLATE,
  SANDBOX_UID,
  SANDBOX_WARM_POOL,
  SERVER_ROLE_BINDING,
  TEAM_NAMESPACE_PREFIX,
  type KobeEndpoint,
} from "./constants.js";

/**
 * Pure builders for everything Kobe puts into a team namespace (spec D11, D12). No I/O: the
 * provider applies them. Anything that builds a pod spec takes a VerifiedIsolation (KOBE-9
 * binding requirement), never a RuntimeClass name string.
 */

export interface KubeMetadata {
  readonly name: string;
  readonly namespace?: string;
  readonly uid?: string;
  /** Optimistic concurrency token (a merge patch carrying it fails with 409 if it changed). */
  readonly resourceVersion?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly annotations?: Readonly<Record<string, string>>;
  readonly creationTimestamp?: string;
  readonly deletionTimestamp?: string;
  readonly ownerReferences?: readonly {
    readonly apiVersion: string;
    readonly kind: string;
    readonly name: string;
    readonly uid: string;
    readonly controller?: boolean;
  }[];
}

/** A Kubernetes object as JSON (spec/status shapes are checked where they are read). */
export interface KubeObject {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: KubeMetadata;
  readonly [field: string]: unknown;
}

export interface TeamRef {
  /** teams.id (uuid). */
  readonly id: string;
  /** teams.slug: immutable, `^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$`. */
  readonly slug: string;
}

const SLUG = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertTeamRef(team: TeamRef): void {
  if (!SLUG.test(team.slug)) throw new TypeError(`invalid team slug "${team.slug}"`);
  if (!UUID.test(team.id)) throw new TypeError("team id must be a lowercase uuid");
}

export const isUuid = (value: string): boolean => UUID.test(value);

export function assertUserId(userId: string): void {
  if (!UUID.test(userId)) throw new TypeError("user id must be a lowercase uuid");
}

export const teamNamespaceName = (team: TeamRef): string => {
  assertTeamRef(team);
  return `${TEAM_NAMESPACE_PREFIX}${team.slug}`;
};

/** One SandboxClaim per (user, team): its name is derived from the user id. */
export const claimName = (userId: string): string => {
  assertUserId(userId);
  return `u-${userId}`;
};

const managedLabels = { [LABEL_MANAGED_BY]: MANAGED_BY };

export function namespaceManifest(team: TeamRef): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: teamNamespaceName(team),
      labels: {
        ...managedLabels,
        [LABEL_TEAM_NAMESPACE]: "true",
        [LABEL_TEAM_ID]: team.id,
        // Pod Security Admission: sandboxes are non-root, no privilege escalation, no capabilities.
        "pod-security.kubernetes.io/enforce": POD_SECURITY_LEVEL,
        "pod-security.kubernetes.io/enforce-version": "latest",
      },
    },
  };
}

/** Grants the server the namespaced verbs it needs here, and nothing in any other namespace. */
export function serverRoleBindingManifest(namespace: string, s: SandboxSettings): KubeObject {
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: { name: SERVER_ROLE_BINDING, namespace, labels: managedLabels },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: s.managerClusterRole,
    },
    subjects: [
      { kind: "ServiceAccount", name: s.serverServiceAccount, namespace: s.releaseNamespace },
    ],
  };
}

/** Kobe services sandboxes may open connections to (the model gateway only once it verifies tokens). */
export const sandboxEgressEndpoints = (s: SandboxSettings): KobeEndpoint[] =>
  KOBE_ENDPOINTS.filter((e) => e !== "modelGateway" || s.modelGatewayAccess);

/**
 * Default deny (spec D11, D28): no ingress at all; egress only to the Kobe server, the model
 * gateway, the MCP proxy and the egress proxy pods, on their pod ports. No DNS (see SANDBOX_HOSTS).
 * Selects every pod in the namespace, so warm-pool pods and future Jobs are covered too.
 */
export function networkPolicyManifest(namespace: string, s: SandboxSettings): KubeObject {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: NETWORK_POLICY, namespace, labels: managedLabels },
    spec: {
      podSelector: {},
      policyTypes: ["Ingress", "Egress"],
      ingress: [],
      egress: sandboxEgressEndpoints(s).map((e) => ({
        to: [
          {
            namespaceSelector: {
              matchLabels: { "kubernetes.io/metadata.name": s.releaseNamespace },
            },
            podSelector: { matchLabels: { ...s.endpoints[e].podLabels } },
          },
        ],
        ports: [{ protocol: "TCP", port: s.endpoints[e].targetPort }],
      })),
    },
  };
}

export function resourceQuotaManifest(namespace: string, s: SandboxSettings): KubeObject {
  return {
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: { name: RESOURCE_QUOTA, namespace, labels: managedLabels },
    spec: { hard: { ...s.teamQuota } },
  };
}

/** Defaults for any container without resources, so the quota never rejects them for that. */
export function limitRangeManifest(namespace: string, s: SandboxSettings): KubeObject {
  return {
    apiVersion: "v1",
    kind: "LimitRange",
    metadata: { name: LIMIT_RANGE, namespace, labels: managedLabels },
    spec: {
      limits: [
        {
          type: "Container",
          default: { ...s.resources.limits, "ephemeral-storage": s.ephemeralStorage.limit },
          defaultRequest: {
            ...s.resources.requests,
            "ephemeral-storage": s.ephemeralStorage.request,
          },
        },
      ],
    },
  };
}

/** Identity for the bootstrap token only: no RBAC binding, no auto-mounted API token. */
export function sandboxServiceAccountManifest(namespace: string): KubeObject {
  return {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: { name: SANDBOX_SERVICE_ACCOUNT, namespace, labels: managedLabels },
    automountServiceAccountToken: false,
  };
}

/** Copy of a registry pull Secret for the kubelet (pods can't mount Secrets: admission policy). */
export function pullSecretManifest(namespace: string, source: KubeObject): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: source.metadata.name, namespace, labels: managedLabels },
    type: source.type,
    data: source.data,
  };
}

/** ClusterIPs of the Kobe Services, by endpoint (for /etc/hosts in sandboxes). */
export type EndpointAddresses = Readonly<Record<KobeEndpoint, string>>;

const url = (scheme: string, host: string, port: number, defaultPort: number): string =>
  `${scheme}://${host}${port === defaultPort ? "" : `:${port}`}`;

function sandboxEnv(s: SandboxSettings): { name: string; value: string }[] {
  const e = s.endpoints;
  // Always with the port: curl and git (libcurl) default a proxy URL without one to 1080, not 80.
  const egress = `http://${SANDBOX_HOSTS.egressProxy}:${e.egressProxy.port}`;
  const noProxy = [
    SANDBOX_HOSTS.server,
    SANDBOX_HOSTS.modelGateway,
    SANDBOX_HOSTS.mcpProxy,
    "localhost",
    "127.0.0.1",
  ].join(",");
  return [
    // The agent dials out (D13); it trades the bootstrap token at the same host over HTTP.
    { name: "KOBE_SERVER_URL", value: url("ws", SANDBOX_HOSTS.server, e.server.port, 80) },
    {
      name: "KOBE_MODEL_GATEWAY_URL",
      value: url("http", SANDBOX_HOSTS.modelGateway, e.modelGateway.port, 80),
    },
    { name: "KOBE_MCP_PROXY_URL", value: url("http", SANDBOX_HOSTS.mcpProxy, e.mcpProxy.port, 80) },
    { name: "KOBE_EGRESS_PROXY_URL", value: egress },
    { name: "KOBE_BOOTSTRAP_TOKEN_FILE", value: BOOTSTRAP_TOKEN_FILE },
    { name: "HTTP_PROXY", value: egress },
    { name: "HTTPS_PROXY", value: egress },
    { name: "http_proxy", value: egress },
    { name: "https_proxy", value: egress },
    { name: "NO_PROXY", value: noProxy },
    { name: "no_proxy", value: noProxy },
    { name: "HOME", value: "/home/kobe" },
    // KOBE-27: how often the agent pushes /workspace changes (through the server); 0 = sync off.
    {
      name: "KOBE_WORKSPACE_SYNC_INTERVAL_MS",
      value: String(s.workspaceSync.enabled ? s.workspaceSync.pushIntervalSeconds * 1000 : 0),
    },
  ];
}

/**
 * The sandbox pod (spec D12, D13). Secrets never enter it: no Secret volumes or env, no API token;
 * its only credential is a projected token whose audience the Kubernetes API rejects.
 */
export function sandboxPodSpec(
  isolation: VerifiedIsolation,
  s: SandboxSettings,
  addresses: EndpointAddresses,
): Record<string, unknown> {
  return {
    runtimeClassName: isolation.runtimeClassName,
    serviceAccountName: SANDBOX_SERVICE_ACCOUNT,
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    hostNetwork: false,
    hostPID: false,
    hostIPC: false,
    // No DNS: Kobe's services resolve through /etc/hosts; everything else goes via the egress proxy.
    dnsPolicy: "None",
    dnsConfig: {
      nameservers: ["127.0.0.1"],
      searches: [],
      options: [{ name: "ndots", value: "1" }],
    },
    hostAliases: KOBE_ENDPOINTS.map((e) => ({ ip: addresses[e], hostnames: [SANDBOX_HOSTS[e]] })),
    ...(s.imagePullSecrets.length > 0
      ? { imagePullSecrets: s.imagePullSecrets.map((name) => ({ name })) }
      : {}),
    securityContext: {
      runAsNonRoot: true,
      runAsUser: SANDBOX_UID,
      runAsGroup: SANDBOX_UID,
      fsGroup: SANDBOX_UID,
      seccompProfile: { type: "RuntimeDefault" },
    },
    containers: [
      {
        name: SANDBOX_CONTAINER,
        image: s.image,
        imagePullPolicy: s.imagePullPolicy,
        env: sandboxEnv(s),
        resources: {
          requests: { ...s.resources.requests, "ephemeral-storage": s.ephemeralStorage.request },
          limits: { ...s.resources.limits, "ephemeral-storage": s.ephemeralStorage.limit },
        },
        securityContext: {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ["ALL"] },
        },
        volumeMounts: [
          { name: "workspace", mountPath: "/workspace" },
          { name: "tmp", mountPath: "/tmp" },
          { name: "home", mountPath: "/home/kobe" },
          { name: "kobe-bootstrap", mountPath: BOOTSTRAP_TOKEN_DIR, readOnly: true },
        ],
      },
    ],
    volumes: [
      // /tmp is wiped on hibernate (D12); so is $HOME (Pi state is rebuilt from Postgres, D13).
      { name: "tmp", emptyDir: { sizeLimit: s.tmpSize } },
      { name: "home", emptyDir: { sizeLimit: s.homeSize } },
      {
        name: "kobe-bootstrap",
        projected: {
          sources: [
            {
              serviceAccountToken: {
                audience: BOOTSTRAP_TOKEN_AUDIENCE,
                expirationSeconds: BOOTSTRAP_TOKEN_SECONDS,
                path: "bootstrap-token",
              },
            },
          ],
        },
      },
    ],
  };
}

/** Template for every sandbox in the team (claims and the warm pool both use it). */
export function sandboxTemplateManifest(
  namespace: string,
  isolation: VerifiedIsolation,
  s: SandboxSettings,
  addresses: EndpointAddresses,
): KubeObject {
  return {
    apiVersion: "extensions.agents.x-k8s.io/v1beta1",
    kind: "SandboxTemplate",
    metadata: { name: SANDBOX_TEMPLATE, namespace, labels: managedLabels },
    spec: {
      // The controller's "Managed" default adds a policy allowing internet egress, which would
      // widen our default deny (NetworkPolicies are additive). Kobe owns the namespace's policy.
      networkPolicyManagement: "Unmanaged",
      envVarsInjectionPolicy: "Disallowed",
      volumeClaimTemplatesPolicy: "Disallowed",
      service: false,
      podTemplate: {
        metadata: { labels: { ...managedLabels, "app.kubernetes.io/name": "kobe-sandbox" } },
        spec: sandboxPodSpec(isolation, s, addresses),
      },
      volumeClaimTemplates: [
        {
          metadata: { name: "workspace", labels: managedLabels },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: { requests: { storage: s.workspace.size } },
            ...(s.workspace.storageClass ? { storageClassName: s.workspace.storageClass } : {}),
          },
        },
      ],
    },
  };
}

/**
 * agent-sandbox warm pools are namespaced (a claim never adopts across namespaces), so each team
 * namespace has its own pool of `replicasPerTeam` pre-started pods (spec D12 says 2 per cluster;
 * see docs/ledger/KOBE-22.md).
 */
export function warmPoolManifest(namespace: string, s: SandboxSettings): KubeObject {
  return {
    apiVersion: "extensions.agents.x-k8s.io/v1beta1",
    kind: "SandboxWarmPool",
    metadata: { name: SANDBOX_WARM_POOL, namespace, labels: managedLabels },
    spec: {
      replicas: s.warmPool.replicasPerTeam,
      sandboxTemplateRef: { name: SANDBOX_TEMPLATE },
      // A changed template (new image, RuntimeClass) replaces idle warm sandboxes right away.
      updateStrategy: { type: "Recreate" },
    },
  };
}

/** A user's sandbox in a team. Its UID is the sandbox id (session token `sub`). */
export function sandboxClaimManifest(namespace: string, team: TeamRef, userId: string): KubeObject {
  return {
    apiVersion: "extensions.agents.x-k8s.io/v1beta1",
    kind: "SandboxClaim",
    metadata: {
      name: claimName(userId),
      namespace,
      labels: { ...managedLabels, [LABEL_USER_ID]: userId },
      annotations: { [ANNOTATION_TEAM_ID]: team.id, [ANNOTATION_USER_ID]: userId },
    },
    spec: {
      warmPoolRef: { name: SANDBOX_WARM_POOL },
      // Identity only (metadata keeps warm-pool adoption possible; env or volumes would not).
      additionalPodMetadata: {
        annotations: { [ANNOTATION_TEAM_ID]: team.id, [ANNOTATION_USER_ID]: userId },
      },
    },
  };
}
