import {
  IsolationRuntimeMissingError,
  type IsolationGate,
  type VerifiedIsolation,
} from "../isolation/gate.js";
import type { SandboxSettings } from "./config.js";
import {
  ANNOTATION_TEAM_ID,
  ANNOTATION_USER_ID,
  BOOTSTRAP_TOKEN_AUDIENCE,
  KOBE_ENDPOINTS,
  LABEL_CLAIM_UID,
  LABEL_TEAM_ID,
  SANDBOX_SERVICE_ACCOUNT,
  TEAM_NAMESPACE_PREFIX,
} from "./constants.js";
import { isKubeStatus, type KubeClient, type ObjectRef } from "./kube.js";
import {
  assertTeamRef,
  assertUserId,
  claimName,
  limitRangeManifest,
  namespaceManifest,
  networkPolicyManifest,
  pullSecretManifest,
  resourceQuotaManifest,
  sandboxClaimManifest,
  sandboxServiceAccountManifest,
  sandboxTemplateManifest,
  serverRoleBindingManifest,
  teamNamespaceName,
  warmPoolManifest,
  type EndpointAddresses,
  type KubeObject,
  type TeamRef,
} from "./manifests.js";
import type { SandboxPrincipal } from "./session-token.js";

/**
 * agent-sandbox provider (spec D11, D12; KOBE-22). One namespace per team with a default-deny
 * NetworkPolicy, a ResourceQuota, a LimitRange, the sandbox template and a warm pool; one
 * SandboxClaim per (user, team) whose UID is the sandbox id.
 *
 * Isolation (KOBE-9 binding requirements): every create path calls isolation.require()
 * immediately before creating, passes the VerifiedIsolation into the spec builders, then reads the
 * result back and deletes it if it is not running under the verified RuntimeClass and handler.
 * The chart's ValidatingAdmissionPolicies pin the same rule at admission time.
 */

export const POD_WAIT_TIMEOUT_MS = 30_000;
/** How long a converged team namespace is trusted before it is applied again. */
export const TEAM_RECONVERGE_MS = 5 * 60_000;
const RBAC_RETRIES = 6;
const POD_NAME_ANNOTATION = "agents.x-k8s.io/pod-name";
const POD_NAME_EXTRA = "authentication.kubernetes.io/pod-name";
const POD_UID_EXTRA = "authentication.kubernetes.io/pod-uid";
const SANDBOX_USER = new RegExp(
  `^system:serviceaccount:(${TEAM_NAMESPACE_PREFIX}[a-z0-9]([a-z0-9-]*[a-z0-9])?):${SANDBOX_SERVICE_ACCOUNT}$`,
);
const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

/** A sandbox could not be provisioned (cluster state, conflicts). Operator-facing message. */
export class SandboxProvisioningError extends Error {
  readonly code = "sandbox_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "SandboxProvisioningError";
  }
}

/** A bootstrap token did not prove a live Kobe sandbox pod. Detail is for logs only. */
export class SandboxAuthError extends Error {
  readonly code = "unauthorized";
  constructor(readonly detail: string) {
    super(`sandbox authentication failed: ${detail}`);
    this.name = "SandboxAuthError";
  }
}

export interface SandboxHandle {
  /** SandboxClaim UID: the session token `sub`. */
  readonly sandboxId: string;
  readonly namespace: string;
  readonly claimName: string;
  readonly sandboxName: string;
  /** "suspended": hibernated (no pod); waking is KOBE-25's. */
  readonly state: "running" | "suspended";
  readonly podName?: string;
}

export type BootstrapIdentity =
  | {
      readonly state: "assigned";
      readonly principal: SandboxPrincipal;
      readonly namespace: string;
      readonly podName: string;
    }
  /** A warm-pool pod not claimed yet (or its claim metadata is still propagating): retry. */
  | { readonly state: "unassigned"; readonly namespace: string; readonly podName: string };

export interface SandboxProviderOptions {
  readonly kube: KubeClient;
  readonly isolation: Pick<IsolationGate, "require">;
  readonly settings: SandboxSettings;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly podWaitTimeoutMs?: number;
}

export interface SandboxProvider {
  /** Creates or converges the team's namespace and everything in it; returns the namespace. */
  ensureTeam(team: TeamRef, isolation: VerifiedIsolation): Promise<string>;
  /** The (user, team) sandbox, created from the warm pool if it does not exist yet. */
  ensureSandbox(team: TeamRef, userId: string): Promise<SandboxHandle>;
  /** Verifies a sandbox pod's bootstrap token (TokenReview) and resolves who it is. */
  identifyBootstrapToken(token: string): Promise<BootstrapIdentity>;
}

const ref = (apiVersion: string, kind: string, name: string, namespace?: string): ObjectRef => ({
  apiVersion,
  kind,
  name,
  ...(namespace ? { namespace } : {}),
});
const CLAIM = (namespace: string, name: string) =>
  ref("extensions.agents.x-k8s.io/v1beta1", "SandboxClaim", name, namespace);
const SANDBOX = (namespace: string, name: string) =>
  ref("agents.x-k8s.io/v1beta1", "Sandbox", name, namespace);
const POD = (namespace: string, name: string) => ref("v1", "Pod", name, namespace);

/** Reads a nested field from an untyped Kubernetes object. */
function field(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
const str = (obj: unknown, ...path: string[]): string | undefined => {
  const v = field(obj, ...path);
  return typeof v === "string" && v !== "" ? v : undefined;
};

export function createSandboxProvider(options: SandboxProviderOptions): SandboxProvider {
  const {
    kube,
    isolation,
    settings,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    podWaitTimeoutMs = POD_WAIT_TIMEOUT_MS,
  } = options;

  /**
   * Team namespaces converged by this process, keyed by team id + RuntimeClass. Entries expire so
   * drift (a deleted NetworkPolicy, a changed Service IP, new settings) is repaired.
   */
  const ensured = new Map<string, { readonly at: number; readonly pending: Promise<string> }>();

  /** RoleBindings take a moment to reach the authorizer: retry 403s right after creating one. */
  const applyWithRbacRetry = async (object: KubeObject): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        await kube.apply(object);
        return;
      } catch (err) {
        if (!isKubeStatus(err, 403) || attempt >= RBAC_RETRIES) throw err;
        await sleep(100 * 2 ** attempt);
      }
    }
  };

  const endpointAddresses = async (): Promise<EndpointAddresses> => {
    const entries = await Promise.all(
      KOBE_ENDPOINTS.map(async (e) => {
        const name = settings.endpoints[e].service;
        const svc = await kube.get(ref("v1", "Service", name, settings.releaseNamespace));
        const ip = str(svc, "spec", "clusterIP");
        if (!ip || !(IPV4.test(ip) || IPV6.test(ip))) {
          throw new SandboxProvisioningError(
            `Service ${settings.releaseNamespace}/${name} has no ClusterIP; sandboxes could not reach it`,
          );
        }
        return [e, ip] as const;
      }),
    );
    return Object.fromEntries(entries) as EndpointAddresses;
  };

  const convergeTeam = async (team: TeamRef, verified: VerifiedIsolation): Promise<string> => {
    const namespace = teamNamespaceName(team);
    const existing = await kube.get(ref("v1", "Namespace", namespace));
    if (existing) {
      const owner = existing.metadata.labels?.[LABEL_TEAM_ID];
      if (owner !== team.id) {
        // Never hand another (or a deleted) team's namespace, volumes included, to this team.
        throw new SandboxProvisioningError(
          `Namespace ${namespace} exists but is not labelled for team ${team.id}; refusing to use it`,
        );
      }
      if (existing.metadata.deletionTimestamp) {
        throw new SandboxProvisioningError(`Namespace ${namespace} is being deleted; retry later`);
      }
    }
    await kube.apply(namespaceManifest(team));
    await kube.apply(serverRoleBindingManifest(namespace, settings));
    // The NetworkPolicy goes first: no pod may ever run here without default deny.
    await applyWithRbacRetry(networkPolicyManifest(namespace, settings));
    await kube.apply(resourceQuotaManifest(namespace, settings));
    await kube.apply(limitRangeManifest(namespace, settings));
    await kube.apply(sandboxServiceAccountManifest(namespace));
    for (const name of settings.imagePullSecrets) {
      const source = await kube.get(ref("v1", "Secret", name, settings.releaseNamespace));
      if (!source) {
        throw new SandboxProvisioningError(
          `Image pull Secret ${settings.releaseNamespace}/${name} does not exist`,
        );
      }
      await kube.apply(pullSecretManifest(namespace, source));
    }
    const addresses = await endpointAddresses();
    await kube.apply(sandboxTemplateManifest(namespace, verified, settings, addresses));
    await kube.apply(warmPoolManifest(namespace, settings));
    return namespace;
  };

  const ensureTeam = (team: TeamRef, verified: VerifiedIsolation): Promise<string> => {
    assertTeamRef(team);
    const key = `${team.id}/${verified.runtimeClassName}/${verified.handler}`;
    const cached = ensured.get(key);
    if (cached && now() - cached.at < TEAM_RECONVERGE_MS) return cached.pending;
    const entry = { at: now(), pending: convergeTeam(team, verified) };
    ensured.set(key, entry);
    // A failed attempt is retried by the next caller rather than cached.
    entry.pending.catch(() => {
      if (ensured.get(key) === entry) ensured.delete(key);
    });
    return entry.pending;
  };

  /** The RuntimeClass still exists with the handler that was verified. */
  const handlerStillVerified = async (verified: VerifiedIsolation): Promise<boolean> => {
    const rc = await kube.get(ref("node.k8s.io/v1", "RuntimeClass", verified.runtimeClassName));
    return field(rc, "handler") === verified.handler;
  };

  const rejectAndDelete = async (
    namespace: string,
    name: string,
    reason: string,
  ): Promise<never> => {
    await kube.delete(CLAIM(namespace, name));
    throw new IsolationRuntimeMissingError(
      `sandbox ${namespace}/${name} was deleted: ${reason}. Only the verified isolation runtime may run sandboxes.`,
    );
  };

  const getOrCreateClaim = async (
    namespace: string,
    team: TeamRef,
    userId: string,
  ): Promise<KubeObject> => {
    const name = claimName(userId);
    let claim = await kube.get(CLAIM(namespace, name));
    if (!claim) {
      try {
        claim = await kube.create(sandboxClaimManifest(namespace, team, userId));
      } catch (err) {
        // Another replica created it first: use that one.
        if (!isKubeStatus(err, 409)) throw err;
        claim = await kube.get(CLAIM(namespace, name));
      }
    }
    if (!claim?.metadata.uid) {
      throw new SandboxProvisioningError(`SandboxClaim ${namespace}/${name} has no UID`);
    }
    if (claim.metadata.deletionTimestamp) {
      throw new SandboxProvisioningError(`Sandbox ${namespace}/${name} is being deleted; retry`);
    }
    const annotations = claim.metadata.annotations ?? {};
    if (annotations[ANNOTATION_TEAM_ID] !== team.id || annotations[ANNOTATION_USER_ID] !== userId) {
      throw new SandboxProvisioningError(
        `SandboxClaim ${namespace}/${name} does not belong to this user and team`,
      );
    }
    return claim;
  };

  const ensureSandbox = async (team: TeamRef, userId: string): Promise<SandboxHandle> => {
    assertTeamRef(team);
    assertUserId(userId);
    // KOBE-9: a fresh check immediately before creating anything that runs agent code.
    const verified = await isolation.require();
    const namespace = await ensureTeam(team, verified);
    const claim = await getOrCreateClaim(namespace, team, userId);
    const name = claim.metadata.name;
    const sandboxId = claim.metadata.uid as string;

    const deadline = now() + podWaitTimeoutMs;
    for (let attempt = 0; ; attempt++) {
      const current = await kube.get(CLAIM(namespace, name));
      if (!current || current.metadata.uid !== sandboxId) {
        throw new SandboxProvisioningError(`SandboxClaim ${namespace}/${name} disappeared`);
      }
      const sandboxName = str(current, "status", "sandbox", "name");
      const sandbox = sandboxName ? await kube.get(SANDBOX(namespace, sandboxName)) : undefined;
      if (sandbox && sandboxName) {
        const templateClass = str(sandbox, "spec", "podTemplate", "spec", "runtimeClassName");
        if (templateClass !== verified.runtimeClassName) {
          return rejectAndDelete(namespace, name, `its template uses "${templateClass ?? "none"}"`);
        }
        if (str(sandbox, "spec", "operatingMode") === "Suspended") {
          return { sandboxId, namespace, claimName: name, sandboxName, state: "suspended" };
        }
        const podName = sandbox.metadata.annotations?.[POD_NAME_ANNOTATION] ?? sandboxName;
        const pod = await kube.get(POD(namespace, podName));
        const owned =
          pod?.metadata.ownerReferences?.some(
            (o) => o.controller && o.kind === "Sandbox" && o.uid === sandbox.metadata.uid,
          ) && pod.metadata.labels?.[LABEL_CLAIM_UID] === sandboxId;
        if (pod && owned) {
          const podClass = str(pod, "spec", "runtimeClassName");
          if (podClass !== verified.runtimeClassName) {
            return rejectAndDelete(namespace, name, `its pod runs under "${podClass ?? "none"}"`);
          }
          if (!(await handlerStillVerified(verified))) {
            return rejectAndDelete(namespace, name, "the RuntimeClass handler changed");
          }
          return { sandboxId, namespace, claimName: name, sandboxName, state: "running", podName };
        }
      }
      if (now() >= deadline) {
        throw new SandboxProvisioningError(
          `Sandbox ${namespace}/${name} has no pod after ${podWaitTimeoutMs} ms (quota or capacity?)`,
        );
      }
      await sleep(Math.min(100 * 2 ** attempt, 1000));
    }
  };

  const identifyBootstrapToken = async (token: string): Promise<BootstrapIdentity> => {
    if (!/^[A-Za-z0-9_.-]{20,8192}$/.test(token)) throw new SandboxAuthError("malformed token");
    const review = await kube.reviewToken(token, [BOOTSTRAP_TOKEN_AUDIENCE]);
    if (!review.authenticated || !review.audiences.includes(BOOTSTRAP_TOKEN_AUDIENCE)) {
      throw new SandboxAuthError("token rejected by the TokenReview");
    }
    const namespace = SANDBOX_USER.exec(review.username ?? "")?.[1];
    const podName = review.extra[POD_NAME_EXTRA]?.[0];
    const podUid = review.extra[POD_UID_EXTRA]?.[0];
    if (!namespace || !podName || !podUid) {
      throw new SandboxAuthError("not a pod-bound token of a team sandbox ServiceAccount");
    }
    // Agent work again: a fresh isolation check before handing out credentials.
    const verified = await isolation.require();
    const pod = await kube.get(POD(namespace, podName));
    if (!pod || pod.metadata.uid !== podUid || pod.metadata.deletionTimestamp) {
      throw new SandboxAuthError(`pod ${namespace}/${podName} is gone`);
    }
    const ns = await kube.get(ref("v1", "Namespace", namespace));
    const teamId = ns?.metadata.labels?.[LABEL_TEAM_ID];
    if (!teamId) throw new SandboxAuthError(`namespace ${namespace} is not a team namespace`);

    const claimUid = pod.metadata.labels?.[LABEL_CLAIM_UID];
    const userId = pod.metadata.annotations?.[ANNOTATION_USER_ID];
    const unassigned = { state: "unassigned", namespace, podName } as const;
    if (!claimUid || !userId || !/^[0-9a-f-]{36}$/.test(userId)) return unassigned;
    const claim = await kube.get(CLAIM(namespace, claimName(userId)));
    const controller = pod.metadata.ownerReferences?.find((o) => o.controller);
    if (
      !claim ||
      claim.metadata.uid !== claimUid ||
      claim.metadata.deletionTimestamp ||
      controller?.kind !== "Sandbox" ||
      str(claim, "status", "sandbox", "name") !== controller.name
    ) {
      return unassigned;
    }
    const annotations = claim.metadata.annotations ?? {};
    if (annotations[ANNOTATION_TEAM_ID] !== teamId || annotations[ANNOTATION_USER_ID] !== userId) {
      throw new SandboxAuthError(`claim ${namespace}/${claim.metadata.name} identity mismatch`);
    }
    if (str(pod, "spec", "runtimeClassName") !== verified.runtimeClassName) {
      return rejectAndDelete(
        namespace,
        claim.metadata.name,
        "its pod is not under the verified runtime",
      );
    }
    return {
      state: "assigned",
      principal: { sandboxId: claimUid, teamId, userId },
      namespace,
      podName,
    };
  };

  return { ensureTeam, ensureSandbox, identifyBootstrapToken };
}
