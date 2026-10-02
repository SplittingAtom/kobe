import { checkIsolation, type RuntimeClassLike } from "./runtime-class.js";

/**
 * The server's own isolation check (spec D4, principle 7). The chart checks at install time and
 * in a hook Job; this gate checks inside the running process at startup, every
 * ISOLATION_RECHECK_INTERVAL_MS, and again before agent work when its last result is older than
 * ISOLATION_MAX_AGE_MS. Without a verified gVisor/Kata RuntimeClass the server keeps serving
 * (sign-in, the admin console showing the fix) but every agent path gets
 * IsolationRuntimeMissingError. It fails closed and has no bypass.
 */
export const ISOLATION_RECHECK_INTERVAL_MS = 60_000;
export const ISOLATION_MAX_AGE_MS = 120_000;
export const ISOLATION_API_TIMEOUT_MS = 10_000;

const UNSET_MESSAGE =
  "KOBE_RUNTIME_CLASS is not set, so the server cannot verify an isolation runtime; agents are " +
  "disabled. Set isolation.runtimeClassName in the Helm values (default 'gvisor'). " +
  "See docs/install.md#isolation.";

export type IsolationStatus =
  | { readonly state: "checking"; readonly runtimeClassName: string }
  | {
      readonly state: "verified";
      readonly runtimeClassName: string;
      readonly handler: string;
      readonly checkedAt: Date;
    }
  | {
      readonly state: "missing";
      readonly runtimeClassName?: string;
      /** What is wrong and how to fix it (operator-facing). */
      readonly message: string;
      readonly checkedAt: Date;
    };

/** What agent work may use: the RuntimeClass sandboxes must run under. */
export interface VerifiedIsolation {
  readonly runtimeClassName: string;
  readonly handler: string;
}

/** Chat and every other agent path return this when isolation is not verified. */
export class IsolationRuntimeMissingError extends Error {
  readonly code = "isolation_runtime_missing";
  readonly status = 503;

  constructor(readonly detail: string) {
    super(`Isolation runtime missing: ${detail}`);
    this.name = "IsolationRuntimeMissingError";
  }

  /** User-facing body: no cluster details; install admins see those in the admin console. */
  toResponseBody(): { code: "isolation_runtime_missing"; message: string } {
    return {
      code: this.code,
      message:
        "Isolation runtime missing: agents are disabled until an install admin fixes the " +
        "cluster's gVisor or Kata runtime.",
    };
  }
}

export interface IsolationGateOptions {
  /** KOBE_RUNTIME_CLASS: the class sandboxes run under. Undefined ⇒ agents stay disabled. */
  readonly runtimeClassName: string | undefined;
  readonly listRuntimeClasses: () => Promise<readonly RuntimeClassLike[]>;
  /** Called once per state transition (for logging), never for a repeated identical state. */
  readonly onChange?: (status: IsolationStatus) => void;
  readonly now?: () => Date;
  readonly recheckIntervalMs?: number;
  readonly maxAgeMs?: number;
  readonly apiTimeoutMs?: number;
}

export interface IsolationGate {
  /** Runs the startup check and schedules periodic re-checks. */
  start(): Promise<IsolationStatus>;
  stop(): void;
  /** Re-checks now (concurrent callers share one Kubernetes API call). */
  check(): Promise<IsolationStatus>;
  status(): IsolationStatus;
  /** Gate for agent work: the verified RuntimeClass, or IsolationRuntimeMissingError. */
  require(): Promise<VerifiedIsolation>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Kubernetes API timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const sameState = (a: IsolationStatus, b: IsolationStatus): boolean =>
  a.state === b.state &&
  (a.state !== "verified" || (b.state === "verified" && a.handler === b.handler)) &&
  (a.state !== "missing" || (b.state === "missing" && a.message === b.message));

export function createIsolationGate(options: IsolationGateOptions): IsolationGate {
  const {
    runtimeClassName,
    listRuntimeClasses,
    onChange,
    now = () => new Date(),
    recheckIntervalMs = ISOLATION_RECHECK_INTERVAL_MS,
    maxAgeMs = ISOLATION_MAX_AGE_MS,
    apiTimeoutMs = ISOLATION_API_TIMEOUT_MS,
  } = options;

  let current: IsolationStatus =
    runtimeClassName === undefined
      ? { state: "missing", message: UNSET_MESSAGE, checkedAt: now() }
      : { state: "checking", runtimeClassName };
  let inFlight: Promise<IsolationStatus> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let reported = false;

  const publish = (next: IsolationStatus): IsolationStatus => {
    const changed = !reported || !sameState(current, next);
    reported = true;
    current = next;
    if (changed) onChange?.(next);
    return next;
  };

  const runCheck = async (name: string): Promise<IsolationStatus> => {
    const result = await checkIsolation(
      () => withTimeout(listRuntimeClasses(), apiTimeoutMs),
      name,
    );
    const checkedAt = now();
    const [verified] = result.ok ? result.runtimeClasses : [];
    return publish(
      verified
        ? { state: "verified", runtimeClassName: name, handler: verified.handler, checkedAt }
        : {
            state: "missing",
            runtimeClassName: name,
            message: result.ok ? "No isolating RuntimeClass found." : result.message,
            checkedAt,
          },
    );
  };

  const check = (): Promise<IsolationStatus> => {
    if (runtimeClassName === undefined) {
      return Promise.resolve(
        publish({ state: "missing", message: UNSET_MESSAGE, checkedAt: now() }),
      );
    }
    inFlight ??= runCheck(runtimeClassName).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const isFresh = (status: IsolationStatus): boolean =>
    status.state === "verified" && now().getTime() - status.checkedAt.getTime() <= maxAgeMs;

  return {
    async start() {
      const status = await check();
      timer ??= setInterval(() => void check(), recheckIntervalMs);
      timer.unref();
      return status;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    check,
    status: () => current,
    async require() {
      const status = isFresh(current) ? current : await check();
      if (status.state === "verified" && isFresh(status)) {
        return { runtimeClassName: status.runtimeClassName, handler: status.handler };
      }
      throw new IsolationRuntimeMissingError(
        status.state === "missing" ? status.message : "isolation has not been verified yet",
      );
    },
  };
}
