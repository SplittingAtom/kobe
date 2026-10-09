import { randomUUID } from "node:crypto";
import {
  KubeApiError,
  type KubeClient,
  type ObjectRef,
  type TokenReviewResult,
} from "../sandbox/kube.js";
import type { KubeMetadata, KubeObject } from "../sandbox/manifests.js";

/**
 * In-memory Kubernetes for sandbox provider tests: objects by (apiVersion, kind, namespace, name),
 * UIDs, background cascade deletion by controller ownerReferences, a call log, failure injection
 * and an optional agent-sandbox controller simulation (claims → Sandbox → Pod).
 */

type Verb = "apply" | "create" | "get" | "list" | "delete" | "patch";
export interface Call {
  readonly verb: Verb;
  readonly kind: string;
  readonly namespace?: string;
  readonly name?: string;
}

const key = (r: { apiVersion: string; kind: string; name: string; namespace?: string }) =>
  `${r.apiVersion}|${r.kind}|${r.namespace ?? ""}|${r.name}`;

const clone = <T>(v: T): T => structuredClone(v);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** RFC 7386 JSON merge patch: objects merge recursively, null removes, anything else replaces. */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return clone(patch);
  const base: Record<string, unknown> = isPlainObject(target) ? clone(target) : {};
  const removed = new Set(Object.keys(patch).filter((k) => patch[k] === null));
  const kept = Object.entries(base).filter(([k]) => !removed.has(k));
  const merged = Object.entries(patch)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => [k, applyMergePatch(base[k], v)] as const);
  return Object.fromEntries([...kept, ...merged]);
}

export interface FakeKube extends KubeClient {
  readonly calls: Call[];
  readonly tokens: Map<string, TokenReviewResult>;
  /** Pod logs by `<namespace>/<pod>`, as `kubectl logs` would print them. */
  readonly podLogs: Map<string, string>;
  /** Puts an object as if something else created it (assigns a uid if missing). */
  seed(object: KubeObject): KubeObject;
  peek(ref: ObjectRef): KubeObject | undefined;
  all(kind?: string): KubeObject[];
  /** The next matching call throws KubeApiError(status). */
  failNext(verb: Verb, kind: string, status: number, times?: number, message?: string): void;
  /** Called after every apply/create (e.g. to simulate a controller). */
  afterWrite?: (object: KubeObject, fake: FakeKube) => void;
  /** Answers a dry-run create (default: the admission policy denies out-of-prefix namespaces). */
  dryRun?: (object: KubeObject) => KubeObject;
  /** Set by simulateAgentSandbox: ends the grace period of terminating pods. */
  finishTermination?: () => void;
  /** Called on every get (e.g. to make a controller act lazily). */
  beforeGet?: (ref: ObjectRef, fake: FakeKube) => void;
}

export function createFakeKube(): FakeKube {
  const store = new Map<string, KubeObject>();
  const failures: {
    verb: Verb;
    kind: string;
    status: number;
    times: number;
    message?: string;
  }[] = [];
  /** Seconds since the epoch for creationTimestamps: strictly increasing in creation order. */
  let fakeClock = 1_790_000_000;
  /** resourceVersion: bumped on every write, like the API server's. */
  let revision = 1;

  const maybeFail = (verb: Verb, kind: string) => {
    const f = failures.find((x) => x.verb === verb && x.kind === kind && x.times > 0);
    if (f) {
      f.times--;
      throw new KubeApiError(f.status, f.message ?? `injected ${f.status} on ${verb} ${kind}`);
    }
  };

  const put = (object: KubeObject, existing?: KubeObject): KubeObject => {
    const metadata: KubeMetadata = {
      ...object.metadata,
      uid: existing?.metadata.uid ?? object.metadata.uid ?? randomUUID(),
      creationTimestamp:
        existing?.metadata.creationTimestamp ??
        object.metadata.creationTimestamp ??
        new Date(fakeClock++ * 1000).toISOString(),
      resourceVersion: String(revision++),
    };
    const stored = clone({ ...object, metadata });
    store.set(key({ ...object, ...object.metadata }), stored);
    return clone(stored);
  };

  const cascade = (uid: string) => {
    for (const [k, obj] of store) {
      if (obj.metadata.ownerReferences?.some((o) => o.uid === uid)) {
        store.delete(k);
        if (obj.metadata.uid) cascade(obj.metadata.uid);
      }
    }
  };

  const fake: FakeKube = {
    calls: [],
    tokens: new Map(),
    podLogs: new Map(),
    seed: (object) => put(object, undefined),
    peek: (r) => {
      const obj = store.get(key(r));
      return obj && clone(obj);
    },
    all: (kind) => [...store.values()].filter((o) => !kind || o.kind === kind).map(clone),
    failNext(verb, kind, status, times = 1, message) {
      failures.push({ verb, kind, status, times, ...(message === undefined ? {} : { message }) });
    },
    async apply(object) {
      fake.calls.push({ verb: "apply", kind: object.kind, ...object.metadata });
      maybeFail("apply", object.kind);
      const existing = store.get(key({ ...object, ...object.metadata }));
      // Apply keeps status and other managers' fields; the applied fields win.
      const merged = existing
        ? { ...existing, ...object, metadata: { ...existing.metadata, ...object.metadata } }
        : object;
      const result = put(merged, existing);
      fake.afterWrite?.(result, fake);
      return result;
    },
    async create(object, options) {
      fake.calls.push({ verb: "create", kind: object.kind, ...object.metadata });
      maybeFail("create", object.kind);
      if (options?.dryRun) {
        if (fake.dryRun) return fake.dryRun(object);
        throw new KubeApiError(
          403,
          `admission webhook denied: Kobe may only manage kobe-team-* namespaces, not ${object.metadata.name}`,
        );
      }
      if (store.has(key({ ...object, ...object.metadata }))) {
        throw new KubeApiError(409, `${object.kind} ${object.metadata.name} already exists`);
      }
      const result = put(object);
      fake.afterWrite?.(result, fake);
      return result;
    },
    async get(r) {
      fake.calls.push({ verb: "get", ...r });
      maybeFail("get", r.kind);
      fake.beforeGet?.(r, fake);
      const obj = store.get(key(r));
      return obj && clone(obj);
    },
    async list(apiVersion, kind, namespace, labelSelector) {
      fake.calls.push({ verb: "list", kind, ...(namespace ? { namespace } : {}) });
      maybeFail("list", kind);
      const [lk, lv] = (labelSelector ?? "").split("=");
      return [...store.values()]
        .filter(
          (o) =>
            o.apiVersion === apiVersion &&
            o.kind === kind &&
            o.metadata.namespace === namespace &&
            (!lk || o.metadata.labels?.[lk] === lv),
        )
        .map(clone);
    },
    async patch(r, body, options) {
      fake.calls.push({ verb: "patch", ...r });
      maybeFail("patch", r.kind);
      const existing = store.get(key(r));
      if (!existing) throw new KubeApiError(404, `${r.kind} ${r.name} not found`);
      if (
        options?.resourceVersion !== undefined &&
        options.resourceVersion !== existing.metadata.resourceVersion
      ) {
        throw new KubeApiError(409, `${r.kind} ${r.name}: the object has been modified`);
      }
      const merged = applyMergePatch(existing, body) as KubeObject;
      const result = put({ ...merged, metadata: merged.metadata }, existing);
      fake.afterWrite?.(result, fake);
      return result;
    },
    async delete(r) {
      fake.calls.push({ verb: "delete", ...r });
      maybeFail("delete", r.kind);
      const obj = store.get(key(r));
      if (!obj) return;
      store.delete(key(r));
      if (obj.metadata.uid) cascade(obj.metadata.uid);
    },
    async logs(r, options) {
      fake.calls.push({
        verb: "get",
        kind: "PodLog",
        ...(r.namespace ? { namespace: r.namespace } : {}),
        name: r.name,
      });
      maybeFail("get", "PodLog");
      const text = fake.podLogs.get(`${r.namespace ?? ""}/${r.name}`);
      return text === undefined ? undefined : text.slice(0, options.limitBytes);
    },
    async reviewToken(token) {
      return fake.tokens.get(token) ?? { authenticated: false, audiences: [], extra: {} };
    },
  };
  return fake;
}

export interface ControllerOptions {
  /** Runtime class the simulated controller puts on pods (default: the template's). */
  readonly podRuntimeClass?: (templateClass: string | undefined) => string | undefined;
  /** Gets of the claim before the controller reacts (simulates latency). */
  readonly delayGets?: number;
  /** Never creates pods (capacity/quota exhaustion). */
  readonly noPods?: boolean;
  /** Suspending leaves the pod terminating until `fake.finishTermination()` (grace period). */
  readonly slowPodTermination?: boolean;
}

/**
 * Simulates the agent-sandbox claim + sandbox controllers: a claim gets a Sandbox copied from the
 * template (named after the claim), the Sandbox a Pod with ownerReferences and the claim-uid label.
 */
export function simulateAgentSandbox(fake: FakeKube, options: ControllerOptions = {}): void {
  let pendingGets = new Map<string, number>();
  const reconcile = (claim: KubeObject) => {
    const ns = claim.metadata.namespace as string;
    const template = fake.peek({
      apiVersion: "extensions.agents.x-k8s.io/v1beta1",
      kind: "SandboxTemplate",
      name: "kobe-sandbox",
      namespace: ns,
    });
    if (!template) return;
    const tspec = template.spec as { podTemplate: { spec: Record<string, unknown> } };
    const sandbox = fake.seed({
      apiVersion: "agents.x-k8s.io/v1beta1",
      kind: "Sandbox",
      metadata: {
        name: claim.metadata.name,
        namespace: ns,
        ownerReferences: [
          {
            apiVersion: claim.apiVersion,
            kind: "SandboxClaim",
            name: claim.metadata.name,
            uid: claim.metadata.uid as string,
            controller: true,
          },
        ],
      },
      spec: { podTemplate: clone(tspec.podTemplate), operatingMode: "Running" },
    });
    fake.seed({ ...claim, status: { sandbox: { name: sandbox.metadata.name } } });
    startPod(sandbox, claim);
  };
  /** The Sandbox controller: a pod from the Sandbox's own podTemplate (named after it). */
  const startPod = (sandbox: KubeObject, claim: KubeObject) => {
    if (options.noPods) return;
    const ns = sandbox.metadata.namespace as string;
    const podSpec = (sandbox.spec as { podTemplate: { spec: Record<string, unknown> } }).podTemplate
      .spec;
    const templateClass = podSpec.runtimeClassName as string | undefined;
    const runtimeClassName = options.podRuntimeClass
      ? options.podRuntimeClass(templateClass)
      : templateClass;
    fake.seed({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: sandbox.metadata.name,
        namespace: ns,
        labels: { "agents.x-k8s.io/claim-uid": claim.metadata.uid as string },
        annotations: {
          ...((claim.spec as { additionalPodMetadata?: { annotations?: Record<string, string> } })
            .additionalPodMetadata?.annotations ?? {}),
        },
        ownerReferences: [
          {
            apiVersion: sandbox.apiVersion,
            kind: "Sandbox",
            name: sandbox.metadata.name,
            uid: sandbox.metadata.uid as string,
            controller: true,
          },
        ],
      },
      spec: { ...podSpec, runtimeClassName },
    });
  };
  /** operatingMode: Suspended deletes the owned pod, Running starts one if there is none. */
  const reconcileSandbox = (sandbox: KubeObject) => {
    const ns = sandbox.metadata.namespace as string;
    const podRef = { apiVersion: "v1", kind: "Pod", name: sandbox.metadata.name, namespace: ns };
    const pod = fake.peek(podRef);
    const owned = pod?.metadata.ownerReferences?.some((o) => o.uid === sandbox.metadata.uid);
    const mode = (sandbox.spec as { operatingMode?: string }).operatingMode;
    if (mode === "Suspended") {
      if (pod && owned) {
        if (options.slowPodTermination) {
          fake.seed({
            ...pod,
            metadata: { ...pod.metadata, deletionTimestamp: new Date().toISOString() },
          });
        } else void fake.delete(podRef);
      }
      return;
    }
    if (pod) return;
    const owner = sandbox.metadata.ownerReferences?.find((o) => o.kind === "SandboxClaim");
    const claim = owner
      ? fake.peek({
          apiVersion: "extensions.agents.x-k8s.io/v1beta1",
          kind: "SandboxClaim",
          name: owner.name,
          namespace: ns,
        })
      : undefined;
    if (claim) startPod(sandbox, claim);
  };
  /** Finishes terminating pods (slowPodTermination): the controller then starts a new one. */
  fake.finishTermination = () => {
    for (const pod of fake.all("Pod")) {
      if (!pod.metadata.deletionTimestamp) continue;
      const ns = pod.metadata.namespace as string;
      void fake.delete({ apiVersion: "v1", kind: "Pod", name: pod.metadata.name, namespace: ns });
      const sandbox = fake.peek({
        apiVersion: "agents.x-k8s.io/v1beta1",
        kind: "Sandbox",
        name: pod.metadata.name,
        namespace: ns,
      });
      if (sandbox) reconcileSandbox(sandbox);
    }
  };
  fake.afterWrite = (object) => {
    if (object.kind === "Sandbox") {
      reconcileSandbox(object);
      return;
    }
    if (object.kind !== "SandboxClaim") return;
    if (options.delayGets) pendingGets.set(object.metadata.uid as string, options.delayGets);
    else reconcile(object);
  };
  fake.beforeGet = (r) => {
    if (r.kind !== "SandboxClaim" || !r.namespace) return;
    const claim = fake.peek(r);
    const uid = claim?.metadata.uid;
    if (!claim || !uid || !pendingGets.has(uid)) return;
    const left = (pendingGets.get(uid) ?? 0) - 1;
    if (left > 0) pendingGets.set(uid, left);
    else {
      pendingGets = new Map([...pendingGets].filter(([k]) => k !== uid));
      reconcile(claim);
    }
  };
}
