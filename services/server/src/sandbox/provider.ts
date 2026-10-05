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
import { replacingPatch } from "./merge-patch.js";
import {
  assertTeamRef,
  assertUserId,
  claimName,
  isUuid,
  limitRangeManifest,
  namespaceManifest,
  evalNetworkPolicyManifest,
  networkPolicyManifest,
  pullSecretManifest,
  resourceQuotaManifest,
  sandboxClaimManifest,
  sandboxPodSpec,
  sandboxServiceAccountManifest,
  sandboxTemplateManifest,
  serverRoleBindingManifest,
  teamNamespaceName,
  warmPoolManifest,
  type EndpointAddresses,
  type KubeObject,
  type TeamRef,
} from "./manifests.js";
import { reconcileTeamNamespaces, type TeamReconcileSummary } from "./team-reconcile.js";
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

/** Rancher's namespace admission webhooks (`rancher.cattle.io.namespaces*`). */
const RANCHER_NAMESPACE_WEBHOOK = /rancher\.cattle\.io\.namespaces/;

export function rancherRefusal(namespace: string): string {
  return (
    `Rancher's namespace webhook (rancher.cattle.io.namespaces) refused team namespace ` +
    `${namespace}: on Rancher-managed clusters the server's ServiceAccount needs 'updatepsa' on ` +
    `projects.management.cattle.io to create namespaces with Pod Security labels. Set the chart ` +
    `value rancher.enabled=true (docs/install.md).`
  );
}

/** A bootstrap token did not prove a live Kobe sandbox pod. Detail is for logs only. */
export class SandboxAuthError extends Error {
  readonly code = "unauthorized";
  constructor(readonly detail: string) {
    super(`sandbox authentication failed: ${detail}`);
    this.name = "SandboxAuthError";
  }
}

/** Outcome of {@link SandboxProvider.hibernateSandbox}. */
export type HibernateOutcome = "suspended" | "already_suspended" | "not_found";

export interface WakeResult {
  readonly handle: SandboxHandle & { readonly state: "running" };
  /** True when this call resumed a hibernated sandbox (false: it was running, or new). */
  readonly resumed: boolean;
}

/** The `/workspace` PVC agent-sandbox creates for a Sandbox (volumeClaimTemplate `workspace`). */
export const workspacePvcName = (sandboxName: string): string => `workspace-${sandboxName}`;

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
  /** Receives audit events; must not throw (failures are the recorder's to log). */
  readonly audit?: (event: SandboxAuditEvent) => Promise<void> | void;
}

/** Audit events the provider emits (recorded by the caller: packages/db `sandbox.*`). */
export type SandboxAuditEvent =
  | {
      readonly action: "sandbox.created";
      readonly teamId: string;
      readonly target: { readonly sandboxId: string; readonly userId: string };
    }
  | {
      readonly action: "sandbox.woken";
      readonly teamId: string;
      readonly target: { readonly sandboxId: string; readonly userId: string };
    }
  | {
      readonly action: "sandbox.destroyed";
      readonly teamId: string;
      readonly target: {
        readonly sandboxId?: string;
        readonly userId?: string;
        readonly pod?: string;
        readonly reason: "isolation_mismatch" | "isolation_lost";
      };
    };

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
  /**
   * The (user, team) sandbox, running (KOBE-25, D14): created if missing, resumed if hibernated.
   * A resume calls isolation.require() first, re-applies the pod template built from the current
   * settings with that VerifiedIsolation, sets `operatingMode: Running` (guarded by the Sandbox's
   * resourceVersion, so concurrent wakes resume once), then verifies the new pod like
   * ensureSandbox (deleted on a RuntimeClass/handler mismatch, KOBE-9).
   */
  wakeSandbox(team: TeamRef, userId: string): Promise<WakeResult>;
  /**
   * Hibernates `sandboxId` (D14): `operatingMode: Suspended` — agent-sandbox deletes the pod and
   * keeps the claim and its volume. Idempotent; no isolation check (stopping is always safe). The
   * caller decides when (KOBE-25 hibernator, under the sandbox row's lock).
   */
  hibernateSandbox(team: TeamRef, userId: string, sandboxId: string): Promise<HibernateOutcome>;
  /**
   * Whether `sandboxId` is still the live sandbox of (team, user): its claim `u-<user>` exists in
   * the team namespace with that UID, is not being deleted, and is annotated for that team and
   * user. The sandbox wire (KOBE-24) checks it at connect and while connected. API errors throw.
   */
  isLive(team: TeamRef, userId: string, sandboxId: string): Promise<boolean>;
  /** Verifies a sandbox pod's bootstrap token (TokenReview) and resolves who it is. */
  identifyBootstrapToken(token: string): Promise<BootstrapIdentity>;
  /**
   * Deletes pods in team namespaces that do not run under the verified RuntimeClass, or predate
   * the current RuntimeClass object. If isolation is definitively gone (class deleted or not
   * isolating) every team pod is deleted; claims and volumes are kept. API errors change nothing.
   */
  reconcileIsolation(): Promise<ReconcileResult>;
  /**
   * Converges every existing team namespace to the current server version with the same function
   * `ensureTeam` uses (KOBE-115): after an upgrade, awake teams get new NetworkPolicies without
   * waiting for their next sandbox setup. Requires verified isolation like any create path.
   */
  reconcileTeams(): Promise<TeamReconcileSummary>;
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
    audit,
  } = options;

  const emit = async (event: SandboxAuditEvent): Promise<void> => {
    try {
      await audit?.(event);
    } catch {
      // Recording is best effort here (no transaction of ours to join); the recorder logs failures.
    }
  };

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

  /**
   * Rancher's namespace webhook refuses namespaces with Pod Security labels unless the caller may
   * `updatepsa` on Rancher projects. Name the webhook and the chart value that grants it.
   */
  const applyNamespace = async (namespace: string, team: TeamRef): Promise<void> => {
    try {
      await kube.apply(namespaceManifest(team));
    } catch (err) {
      if (err instanceof KubeApiError && RANCHER_NAMESPACE_WEBHOOK.test(err.message)) {
        throw new SandboxProvisioningError(rancherRefusal(namespace));
      }
      throw err;
    }
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
    await applyNamespace(namespace, team);
    await kube.apply(serverRoleBindingManifest(namespace, settings));
    // The NetworkPolicy goes first: no pod may ever run here without default deny.
    await applyWithRbacRetry(networkPolicyManifest(namespace, settings));
    await applyWithRbacRetry(evalNetworkPolicyManifest(namespace, settings));
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
    owner: { readonly teamId: string; readonly userId: string; readonly sandboxId: string },
    namespace: string,
    name: string,
    reason: string,
    podName?: string,
  ): Promise<never> => {
    const claimGone = await deleteWithRetry(CLAIM(namespace, name));
    // The pod directly too: it must stop even if the claim's cascade is slow or the delete failed.
    const podGone = podName ? await deleteWithRetry(POD(namespace, podName)) : true;
    await emit({
      action: "sandbox.destroyed",
      teamId: owner.teamId,
      target: {
        sandboxId: owner.sandboxId,
        userId: owner.userId,
        ...(podName ? { pod: podName } : {}),
        reason: "isolation_mismatch",
      },
    });
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
        if (claim.metadata.uid) {
          await emit({
            action: "sandbox.created",
            teamId: team.id,
            target: { sandboxId: claim.metadata.uid, userId },
          });
        }
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

  /**
   * Re-applies the pod template from the current settings and sets Running, guarded by the
   * resourceVersion read with it. False when the Sandbox changed meanwhile (409): re-read it.
   */
  const resume = async (
    namespace: string,
    sandbox: KubeObject,
    verified: VerifiedIsolation,
  ): Promise<boolean> => {
    const next = sandboxPodSpec(verified, settings, await endpointAddresses());
    const current = field(sandbox, "spec", "podTemplate", "spec");
    try {
      await kube.patch(
        SANDBOX(namespace, sandbox.metadata.name),
        {
          spec: {
            operatingMode: "Running",
            podTemplate: { spec: replacingPatch(current, next) },
          },
        },
        sandbox.metadata.resourceVersion
          ? { resourceVersion: sandbox.metadata.resourceVersion }
          : {},
      );
      return true;
    } catch (err) {
      if (isKubeStatus(err, 409)) return false;
      throw err;
    }
  };

  const ensureSandbox = (team: TeamRef, userId: string): Promise<SandboxHandle> =>
    provision(team, userId, false).then((r) => r.handle);

  const provision = async (
    team: TeamRef,
    userId: string,
    wake: boolean,
  ): Promise<{ handle: SandboxHandle; resumed: boolean }> => {
    assertTeamRef(team);
    assertUserId(userId);
    // KOBE-9: a fresh check immediately before creating anything that runs agent code.
    const verified = await isolation.require();
    const namespace = await ensureTeam(team, verified);
    const claim = await getOrCreateClaim(namespace, team, userId);
    const name = claim.metadata.name;
    const sandboxId = claim.metadata.uid as string;
    const owner = { teamId: team.id, userId, sandboxId };

    const deadline = now() + podWaitTimeoutMs;
    let resumed = false;
    for (let attempt = 0; ; attempt++) {
      const current = await kube.get(CLAIM(namespace, name));
      if (!current || current.metadata.uid !== sandboxId) {
        throw new SandboxProvisioningError(`SandboxClaim ${namespace}/${name} disappeared`);
      }
      const sandboxName = str(current, "status", "sandbox", "name");
      const sandbox = sandboxName ? await kube.get(SANDBOX(namespace, sandboxName)) : undefined;
      if (sandbox && sandboxName) {
        const suspended = str(sandbox, "spec", "operatingMode") === "Suspended";
        if (suspended && wake) {
          // The stored template is replaced wholesale (built with `verified`), then re-checked.
          if (await resume(namespace, sandbox, verified)) {
            resumed = true;
            // Audited when the resume is committed, whether or not its pod then verifies.
            await emit({ action: "sandbox.woken", teamId: team.id, target: { sandboxId, userId } });
          } else if (now() >= deadline) {
            throw new SandboxProvisioningError(`Sandbox ${namespace}/${name} could not be resumed`);
          } else await sleep(Math.min(100 * 2 ** attempt, 1000));
          continue;
        }
        if (suspended) {
          // Nothing runs while suspended, so a stale template is no isolation risk: never delete
          // (the claim owns the volume). A wake replaces the template before anything starts.
          return {
            handle: { sandboxId, namespace, claimName: name, sandboxName, state: "suspended" },
            resumed,
          };
        }
        const templateClass = str(sandbox, "spec", "podTemplate", "spec", "runtimeClassName");
        if (templateClass !== verified.runtimeClassName) {
          return rejectAndDelete(
            owner,
            namespace,
            name,
            `its template uses "${templateClass ?? "none"}"`,
          );
        }
        const podName = sandbox.metadata.annotations?.[POD_NAME_ANNOTATION] ?? sandboxName;
        const pod = await kube.get(POD(namespace, podName));
        // A pod still terminating after a hibernation is not this sandbox's next pod: wait.
        const owned =
          !pod?.metadata.deletionTimestamp &&
          pod?.metadata.ownerReferences?.some(
            (o) => o.controller && o.kind === "Sandbox" && o.uid === sandbox.metadata.uid,
          ) &&
          pod.metadata.labels?.[LABEL_CLAIM_UID] === sandboxId;
        if (pod && owned) {
          const podClass = str(pod, "spec", "runtimeClassName");
          if (podClass !== verified.runtimeClassName) {
            return rejectAndDelete(
              owner,
              namespace,
              name,
              `its pod runs under "${podClass ?? "none"}"`,
              podName,
            );
          }
          if (!(await stillVerified(verified, pod))) {
            return rejectAndDelete(
              owner,
              namespace,
              name,
              "the RuntimeClass handler changed or the class was recreated",
              podName,
            );
          }
          return {
            handle: {
              sandboxId,
              namespace,
              claimName: name,
              sandboxName,
              state: "running",
              podName,
            },
            resumed,
          };
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

  const wakeSandbox = async (team: TeamRef, userId: string): Promise<WakeResult> => {
    const { handle, resumed } = await provision(team, userId, true);
    if (handle.state !== "running") {
      throw new SandboxProvisioningError(
        `Sandbox ${handle.namespace}/${handle.claimName} did not resume`,
      );
    }
    return { handle: { ...handle, state: "running" }, resumed };
  };

  const hibernateSandbox = async (
    team: TeamRef,
    userId: string,
    sandboxId: string,
  ): Promise<HibernateOutcome> => {
    const namespace = teamNamespaceName(team);
    for (let attempt = 0; ; attempt++) {
      const claim = await kube.get(CLAIM(namespace, claimName(userId)));
      if (!claim || claim.metadata.uid !== sandboxId || claim.metadata.deletionTimestamp) {
        return "not_found";
      }
      const sandboxName = str(claim, "status", "sandbox", "name");
      const sandbox = sandboxName ? await kube.get(SANDBOX(namespace, sandboxName)) : undefined;
      if (!sandbox) return "not_found";
      if (str(sandbox, "spec", "operatingMode") === "Suspended") return "already_suspended";
      try {
        await kube.patch(
          SANDBOX(namespace, sandbox.metadata.name),
          { spec: { operatingMode: "Suspended" } },
          sandbox.metadata.resourceVersion
            ? { resourceVersion: sandbox.metadata.resourceVersion }
            : {},
        );
        return "suspended";
      } catch (err) {
        // Changed since read (e.g. the claim controller synced metadata): read it again.
        if (!isKubeStatus(err, 409) || attempt >= 3) throw err;
      }
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
        { teamId, userId, sandboxId: claimUid },
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

  const deletePodAndClaim = async (
    pod: KubeObject,
    teamId: string | undefined,
    withClaim: boolean,
  ): Promise<boolean> => {
    const namespace = pod.metadata.namespace as string;
    const annotated = pod.metadata.annotations?.[ANNOTATION_USER_ID];
    const userId = annotated && isUuid(annotated) ? annotated : undefined;
    const claimUid = pod.metadata.labels?.[LABEL_CLAIM_UID];
    const sandboxId = claimUid && isUuid(claimUid) ? claimUid : undefined;
    if (withClaim && userId) {
      const claim = await kube.get(CLAIM(namespace, claimName(userId)));
      if (claim && claim.metadata.uid === claimUid) {
        await deleteWithRetry(CLAIM(namespace, claim.metadata.name));
      }
    }
    const gone = await deleteWithRetry(POD(namespace, pod.metadata.name));
    if (gone && teamId && isUuid(teamId)) {
      await emit({
        action: "sandbox.destroyed",
        teamId,
        target: {
          ...(sandboxId ? { sandboxId } : {}),
          ...(userId ? { userId } : {}),
          pod: pod.metadata.name,
          reason: withClaim ? "isolation_mismatch" : "isolation_lost",
        },
      });
    }
    return gone;
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
        if (
          await deletePodAndClaim(pod, ns.metadata.labels?.[LABEL_TEAM_ID], verified !== undefined)
        ) {
          deleted.push(`${namespace}/${pod.metadata.name}`);
        }
      }
    }
    return {
      deleted,
      ...(lost ? { reason: lost } : deleted.length > 0 ? { reason: "unverified runtime" } : {}),
    };
  };

  const isLive = async (team: TeamRef, userId: string, sandboxId: string): Promise<boolean> => {
    if (!isUuid(userId) || !isUuid(sandboxId)) return false;
    const claim = await kube.get(CLAIM(teamNamespaceName(team), claimName(userId)));
    if (!claim || claim.metadata.uid !== sandboxId || claim.metadata.deletionTimestamp)
      return false;
    const annotations = claim.metadata.annotations ?? {};
    return (
      annotations[ANNOTATION_TEAM_ID] === team.id && annotations[ANNOTATION_USER_ID] === userId
    );
  };

  const reconcileTeams = async (): Promise<TeamReconcileSummary> => {
    const verified = await isolation.require();
    return reconcileTeamNamespaces({ kube, converge: (team) => convergeTeam(team, verified) });
  };

  return {
    ensureTeam,
    reconcileTeams,
    ensureSandbox,
    wakeSandbox,
    hibernateSandbox,
    identifyBootstrapToken,
    reconcileIsolation,
    isLive,
  };
}
