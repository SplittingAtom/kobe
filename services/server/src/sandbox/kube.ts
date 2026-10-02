import {
  ApiException,
  AuthenticationV1Api,
  KubeConfig,
  KubernetesObjectApi,
  PatchStrategy,
  type KubernetesObject,
} from "@kubernetes/client-node";
import type { KubeObject } from "./manifests.js";

/**
 * The narrow Kubernetes surface the sandbox provider uses, so tests run against an in-memory fake
 * (src/testing/fake-kube.ts) and the real client stays a thin adapter.
 */
export interface ObjectRef {
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
  readonly namespace?: string;
}

export interface TokenReviewResult {
  readonly authenticated: boolean;
  readonly audiences: readonly string[];
  readonly username?: string;
  readonly extra: Readonly<Record<string, readonly string[]>>;
}

export interface KubeClient {
  /** Server-side apply (field manager `kobe-server`, force): create or converge. */
  apply(object: KubeObject): Promise<KubeObject>;
  /** Plain create; throws KubeApiError with status 409 when the object exists. */
  create(object: KubeObject, options?: { readonly dryRun?: boolean }): Promise<KubeObject>;
  /** undefined when the object does not exist. */
  get(ref: ObjectRef): Promise<KubeObject | undefined>;
  /** Lists in a namespace, or cluster-wide for cluster-scoped kinds (namespace undefined). */
  list(
    apiVersion: string,
    kind: string,
    namespace?: string,
    labelSelector?: string,
  ): Promise<KubeObject[]>;
  /** Deletes with background propagation; a missing object is not an error. */
  delete(ref: ObjectRef): Promise<void>;
  reviewToken(token: string, audiences: readonly string[]): Promise<TokenReviewResult>;
}

export class KubeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "KubeApiError";
  }
}

export const isKubeStatus = (err: unknown, status: number): boolean =>
  err instanceof KubeApiError && err.status === status;

export const FIELD_MANAGER = "kobe-server";
export const KUBE_API_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Kubernetes API ${what} timed out after ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The Kubernetes Status message from a client error body. @kubernetes/client-node passes the raw
 * response text (a JSON Status) as the body; older paths pass a parsed object.
 */
export function statusMessage(body: unknown): string | undefined {
  let value = body;
  if (typeof body === "string") {
    try {
      value = JSON.parse(body) as unknown;
    } catch {
      return body.slice(0, 500) || undefined;
    }
  }
  const message = (value as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" ? message : undefined;
}

/** Normalises client errors: status code and the API's message, never request bodies. */
function translate(err: unknown, what: string): never {
  if (err instanceof ApiException) {
    const detail = statusMessage(err.body) ?? `HTTP ${err.code}`;
    throw new KubeApiError(err.code, `Kubernetes API ${what}: ${detail}`);
  }
  throw err instanceof Error ? err : new Error(String(err));
}

const describe = (ref: ObjectRef): string =>
  `${ref.kind} ${ref.namespace ? `${ref.namespace}/` : ""}${ref.name}`;

interface Header {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string };
}

const header = (ref: ObjectRef): Header => ({
  apiVersion: ref.apiVersion,
  kind: ref.kind,
  metadata: { name: ref.name, ...(ref.namespace ? { namespace: ref.namespace } : {}) },
});

/** JSON round trip: typed client models (Date fields, classes) become plain JSON objects. */
const plain = <T>(value: T): KubeObject => JSON.parse(JSON.stringify(value)) as KubeObject;

/** Uses the in-cluster ServiceAccount (or local kubeconfig). */
export function createKubeClient(timeoutMs = KUBE_API_TIMEOUT_MS): KubeClient {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const objects = KubernetesObjectApi.makeApiClient(kc);
  const auth = kc.makeApiClient(AuthenticationV1Api);

  const call = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await withTimeout(fn(), timeoutMs, what);
    } catch (err) {
      return translate(err, what);
    }
  };

  return {
    apply: async (object) =>
      plain(
        await call(`apply ${describe({ ...object, ...object.metadata })}`, () =>
          objects.patch(
            object as unknown as KubernetesObject,
            undefined,
            undefined,
            FIELD_MANAGER,
            true,
            PatchStrategy.ServerSideApply,
          ),
        ),
      ),
    create: async (object, options) =>
      plain(
        await call(`create ${describe({ ...object, ...object.metadata })}`, () =>
          objects.create(
            object as unknown as KubernetesObject,
            undefined,
            options?.dryRun ? "All" : undefined,
            FIELD_MANAGER,
          ),
        ),
      ),
    async get(ref) {
      try {
        return plain(await call(`get ${describe(ref)}`, () => objects.read(header(ref))));
      } catch (err) {
        if (isKubeStatus(err, 404)) return undefined;
        throw err;
      }
    },
    list: async (apiVersion, kind, namespace, labelSelector) => {
      const result = await call(`list ${kind} in ${namespace ?? "cluster"}`, () =>
        objects.list(
          apiVersion,
          kind,
          namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          labelSelector,
        ),
      );
      return result.items.map(plain);
    },
    async delete(ref) {
      try {
        await call(`delete ${describe(ref)}`, () =>
          objects.delete(header(ref), undefined, undefined, undefined, undefined, "Background"),
        );
      } catch (err) {
        if (!isKubeStatus(err, 404)) throw err;
      }
    },
    async reviewToken(token, audiences) {
      const review = await call("create TokenReview", () =>
        auth.createTokenReview({
          body: {
            apiVersion: "authentication.k8s.io/v1",
            kind: "TokenReview",
            spec: { token, audiences: [...audiences] },
          },
        }),
      );
      const status = review.status ?? {};
      const username = status.user?.username;
      return {
        authenticated: status.authenticated === true,
        audiences: status.audiences ?? [],
        ...(username ? { username } : {}),
        extra: status.user?.extra ?? {},
      };
    },
  };
}
