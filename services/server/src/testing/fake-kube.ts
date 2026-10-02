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

type Verb = "apply" | "create" | "get" | "list" | "delete";
export interface Call {
  readonly verb: Verb;
  readonly kind: string;
  readonly namespace?: string;
  readonly name?: string;
}

const key = (r: { apiVersion: string; kind: string; name: string; namespace?: string }) =>
  `${r.apiVersion}|${r.kind}|${r.namespace ?? ""}|${r.name}`;

const clone = <T>(v: T): T => structuredClone(v);

export interface FakeKube extends KubeClient {
  readonly calls: Call[];
  readonly tokens: Map<string, TokenReviewResult>;
  /** Puts an object as if something else created it (assigns a uid if missing). */
  seed(object: KubeObject): KubeObject;
  peek(ref: ObjectRef): KubeObject | undefined;
  all(kind?: string): KubeObject[];
  /** The next matching call throws KubeApiError(status). */
  failNext(verb: Verb, kind: string, status: number, times?: number): void;
  /** Called after every apply/create (e.g. to simulate a controller). */
  afterWrite?: (object: KubeObject, fake: FakeKube) => void;
  /** Answers a dry-run create (default: the admission policy denies out-of-prefix namespaces). */
  dryRun?: (object: KubeObject) => KubeObject;
  /** Called on every get (e.g. to make a controller act lazily). */
  beforeGet?: (ref: ObjectRef, fake: FakeKube) => void;
}

export function createFakeKube(): FakeKube {
  const store = new Map<string, KubeObject>();
  const failures: { verb: Verb; kind: string; status: number; times: number }[] = [];
  /** Seconds since the epoch for creationTimestamps: strictly increasing in creation order. */
  let fakeClock = 1_790_000_000;

  const maybeFail = (verb: Verb, kind: string) => {
    const f = failures.find((x) => x.verb === verb && x.kind === kind && x.times > 0);
    if (f) {
      f.times--;
      throw new KubeApiError(f.status, `injected ${f.status} on ${verb} ${kind}`);
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
    seed: (object) => put(object, undefined),
    peek: (r) => {
      const obj = store.get(key(r));
      return obj && clone(obj);
    },
    all: (kind) => [...store.values()].filter((o) => !kind || o.kind === kind).map(clone),
    failNext(verb, kind, status, times = 1) {
      failures.push({ verb, kind, status, times });
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
    async delete(r) {
      fake.calls.push({ verb: "delete", ...r });
      maybeFail("delete", r.kind);
      const obj = store.get(key(r));
      if (!obj) return;
      store.delete(key(r));
      if (obj.metadata.uid) cascade(obj.metadata.uid);
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
    if (options.noPods) return;
    const templateClass = tspec.podTemplate.spec.runtimeClassName as string | undefined;
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
      spec: { ...tspec.podTemplate.spec, runtimeClassName },
    });
  };
  fake.afterWrite = (object) => {
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
