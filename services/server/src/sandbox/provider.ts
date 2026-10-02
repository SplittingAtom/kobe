import {
  IsolationRuntimeMissingError,
  type IsolationGate,
  type VerifiedIsolation,
} from "../isolation/gate.js";
import type { SandboxSettings } from "./config.js";
import { isIsolationHandler } from "../isolation/runtime-class.js";
import {
  ANNOTATION_TEAM_ID,
  ANNOTATION_USER_ID,
  BOOTSTRAP_TOKEN_AUDIENCE,
  KOBE_ENDPOINTS,
  LABEL_CLAIM_UID,
  LABEL_TEAM_ID,
  LABEL_TEAM_NAMESPACE,
  POD_SECURITY_LEVEL,
  SANDBOX_SERVICE_ACCOUNT,
  TEAM_NAMESPACE_PREFIX,
} from "./constants.js";
import { KubeApiError, isKubeStatus, type KubeClient, type ObjectRef } from "./kube.js";
import {
  assertTeamRef,
  assertUserId,
  claimName,
  isUuid,
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
/** Name of the dry-run namespace the admission self-check expects to be refused. */
export const ADMISSION_PROBE_NAMESPACE = "kobe-admission-probe";
const DELETE_RETRIES = 4;
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
  /**
   * The configured RuntimeClass (KOBE_RUNTIME_CLASS). Used only by the reconciler, to recognise a
   * definitive loss of isolation (class deleted or no longer isolating) when require() fails.
   */
  readonly runtimeClassName?: string;
}

export interface ReconcileResult {
  /** Pods deleted (namespace/name). */
  readonly deleted: readonly string[];
  readonly reason?: string;
}

export interface SandboxProvider {
  /** Creates or converges the team's namespace and everything in it; returns the namespace. */
  ensureTeam(team: TeamRef, isolation: VerifiedIsolation): Promise<string>;
  /** The (user, team) sandbox, created from the warm pool if it does not exist yet. */
  ensureSandbox(team: TeamRef, userId: string): Promise<SandboxHandle>;
  /** Verifies a sandbox pod's bootstrap token (TokenReview) and resolves who it is. */
  identifyBootstrapToken(token: string): Promise<BootstrapIdentity>;
  /**
   * Deletes pods in team namespaces that do not run under the verified RuntimeClass, or predate
   * the current RuntimeClass object. If isolation is definitively gone (class deleted or not
   * isolating) every team pod is deleted; claims and volumes are kept. API errors change nothing.
   */
  reconcileIsolation(): Promise<ReconcileResult>;
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
    runtimeClassName,
  } = options;

  /**
   * The chart's admission policies confine the server's cluster-wide RBAC and pin isolation. Before
   * provisioning, prove they are in effect: a server-side dry run of a namespace outside
   * kobe-team-* must be refused by them. Otherwise refuse to provision (fail closed).
   */
  let admissionVerified = false;
  const checkAdmission = async (): Promise<void> => {
    if (admissionVerified) return;
    try {
      await kube.create(
        {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: {
            name: ADMISSION_PROBE_NAMESPACE,
            labels: {
              [LABEL_TEAM_NAMESPACE]: "true",
              "pod-security.kubernetes.io/enforce": POD_SECURITY_LEVEL,
            },
          },
        },
        { dryRun: true },
      );
    } catch (err) {
      if (err instanceof KubeApiError && /kobe-team-\* namespaces/.test(err.message)) {
        admissionVerified = true;
        return;
      }
      throw err;
    }
    throw new SandboxProvisioningError(
      "Kobe's sandbox admission policies are not in effect (a dry-run namespace outside " +
        "kobe-team-* was allowed); refusing to provision sandboxes. Install the chart's " +
        "ValidatingAdmissionPolicies (Kubernetes >= 1.30).",
    );
  };

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
    await checkAdmission();
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

  /**
   * The RuntimeClass still exists with the handler that was verified, and the pod was created
   * after that RuntimeClass object (a class recreated with another handler must not pass old pods).
   */
  const stillVerified = async (verified: VerifiedIsolation, pod: KubeObject): Promise<boolean> => {
    const rc = await kube.get(ref("node.k8s.io/v1", "RuntimeClass", verified.runtimeClassName));
    if (!rc || field(rc, "handler") !== verified.handler) return false;
    const rcCreated = Date.parse(rc.metadata.creationTimestamp ?? "");
    const podCreated = Date.parse(pod.metadata.creationTimestamp ?? "");
    return !(rcCreated > podCreated);
  };

  /** Deletes with retries; false if it still failed (the reconciler retries later). */
  const deleteWithRetry = async (target: ObjectRef): Promise<boolean> => {
    for (let attempt = 0; attempt <= DELETE_RETRIES; attempt++) {
      try {
        await kube.delete(target);
        return true;
      } catch {
        if (attempt < DELETE_RETRIES) await sleep(200 * 2 ** attempt);
      }
    }
    return false;
  };

  const rejectAndDelete = async (
    namespace: string,
    name: string,
    reason: string,
    podName?: string,
  ): Promise<never> => {
    const claimGone = await deleteWithRetry(CLAIM(namespace, name));
    // The pod directly too: it must stop even if the claim's cascade is slow or the delete failed.
    const podGone = podName ? await deleteWithRetry(POD(namespace, podName)) : true;
    throw new IsolationRuntimeMissingError(
      `sandbox ${namespace}/${name} ${claimGone && podGone ? "was deleted" : "is being deleted"}: ${reason}. ` +
        "Only the verified isolation runtime may run sandboxes.",
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
            return rejectAndDelete(
              namespace,
              name,
              `its pod runs under "${podClass ?? "none"}"`,
              podName,
            );
          }
          if (!(await stillVerified(verified, pod))) {
            return rejectAndDelete(
              namespace,
              name,
              "the RuntimeClass handler changed or the class was recreated",
              podName,
            );
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
    if (!claimUid || !userId) return unassigned;
    if (!isUuid(userId))
      throw new SandboxAuthError(`pod ${namespace}/${podName} has a malformed user id`);
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
    if (
      str(pod, "spec", "runtimeClassName") !== verified.runtimeClassName ||
      !(await stillVerified(verified, pod))
    ) {
      return rejectAndDelete(
        namespace,
        claim.metadata.name,
        "its pod is not under the verified runtime",
        podName,
      );
    }
    return {
      state: "assigned",
      principal: { sandboxId: claimUid, teamId, userId },
      namespace,
      podName,
    };
  };

  /** Definitive loss only: the configured class is gone (404) or its handler does not isolate. */
  const isolationDefinitivelyLost = async (): Promise<string | undefined> => {
    if (!runtimeClassName) return undefined;
    const rc = await kube.get(ref("node.k8s.io/v1", "RuntimeClass", runtimeClassName));
    if (!rc) return `RuntimeClass ${runtimeClassName} no longer exists`;
    const handler = field(rc, "handler");
    return typeof handler === "string" && isIsolationHandler(handler)
      ? undefined
      : `RuntimeClass ${runtimeClassName} no longer isolates`;
  };

  const deletePodAndClaim = async (pod: KubeObject, withClaim: boolean): Promise<boolean> => {
    const namespace = pod.metadata.namespace as string;
    const userId = pod.metadata.annotations?.[ANNOTATION_USER_ID];
    if (withClaim && userId && isUuid(userId)) {
      const claim = await kube.get(CLAIM(namespace, claimName(userId)));
      if (claim && claim.metadata.uid === pod.metadata.labels?.[LABEL_CLAIM_UID]) {
        await deleteWithRetry(CLAIM(namespace, claim.metadata.name));
      }
    }
    return deleteWithRetry(POD(namespace, pod.metadata.name));
  };

  const reconcileIsolation = async (): Promise<ReconcileResult> => {
    let verified: VerifiedIsolation | undefined;
    let lost: string | undefined;
    try {
      verified = await isolation.require();
    } catch (err) {
      if (!(err instanceof IsolationRuntimeMissingError)) throw err;
      lost = await isolationDefinitivelyLost();
      // Not definitive (e.g. API unreachable): change nothing, check again next time.
      if (!lost) return { deleted: [] };
    }
    const namespaces = await kube.list(
      "v1",
      "Namespace",
      undefined,
      `${LABEL_TEAM_NAMESPACE}=true`,
    );
    const deleted: string[] = [];
    for (const ns of namespaces) {
      const namespace = ns.metadata.name;
      if (!namespace.startsWith(TEAM_NAMESPACE_PREFIX)) continue;
      for (const pod of await kube.list("v1", "Pod", namespace)) {
        if (pod.metadata.deletionTimestamp) continue;
        const ok =
          verified !== undefined &&
          str(pod, "spec", "runtimeClassName") === verified.runtimeClassName &&
          (await stillVerified(verified, pod));
        if (ok) continue;
        // Lost isolation: stop pods, keep claims (and volumes) for when it is restored.
        if (await deletePodAndClaim(pod, verified !== undefined)) {
          deleted.push(`${namespace}/${pod.metadata.name}`);
        }
      }
    }
    return {
      deleted,
      ...(lost ? { reason: lost } : deleted.length > 0 ? { reason: "unverified runtime" } : {}),
    };
  };

  return { ensureTeam, ensureSandbox, identifyBootstrapToken, reconcileIsolation };
}
