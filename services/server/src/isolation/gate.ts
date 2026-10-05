import { ISOLATION_REMEDIATION, checkIsolation, type RuntimeClassLike } from "./runtime-class.js";

/**
 * The server's own isolation check (spec D4, principle 7). The chart checks at install time and
 * in a hook Job; this gate checks inside the running process at startup, every
 * ISOLATION_RECHECK_INTERVAL_MS, and with a fresh check on every require() before agent work,
 * so a RuntimeClass deleted or replaced after boot is caught when it matters. Without a verified
 * gVisor/Kata RuntimeClass the server keeps serving (sign-in, the admin console showing the
 * fix) but every agent path gets
 * IsolationRuntimeMissingError. It fails closed and has no bypass.
 */
export const ISOLATION_RECHECK_INTERVAL_MS = 60_000;
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

const MINT = Symbol("VerifiedIsolation.mint");
const TOKEN = Symbol("VerifiedIsolation.token");

/**
 * Proof that a live check just verified the sandbox RuntimeClass. Only IsolationGate.require()
 * can create one: the constructor is private and guarded by a module-private token, and the
 * `#verified` field makes the type nominal, so an object literal with the same fields does not
 * type-check and fails VerifiedIsolation.assert() at runtime.
 *
 * BINDING for sandbox orchestration (KOBE-22/30/64): anything that creates a sandbox or pod must
 * take a VerifiedIsolation obtained from require() immediately before the create call, and use its
 * runtimeClassName. Never accept a raw RuntimeClass name string, config.runtimeClassName or
 * IsolationGate.status() instead.
 */
export class VerifiedIsolation {
  readonly #verified = true;

  private constructor(
    token: symbol,
    readonly runtimeClassName: string,
    readonly handler: string,
  ) {
    if (token !== TOKEN) throw new TypeError("VerifiedIsolation comes only from require()");
    Object.freeze(this);
  }

  /** Module-private factory (MINT is not exported). */
  static [MINT](runtimeClassName: string, handler: string): VerifiedIsolation {
    return new VerifiedIsolation(TOKEN, runtimeClassName, handler);
  }

  /** Runtime guard for values crossing an untyped boundary. */
  static assert(value: unknown): asserts value is VerifiedIsolation {
    if (!(value instanceof VerifiedIsolation) || !value.#verified) {
      throw new TypeError("Not a VerifiedIsolation from IsolationGate.require()");
    }
  }
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
  readonly apiTimeoutMs?: number;
  /**
   * start() tries this many times (default 1) before publishing "missing", staying "checking"
   * (so /readyz is not ready) in between: a transient Kubernetes API failure at boot must not
   * leave a serving pod unverified for a whole recheck interval.
   */
  readonly startupAttempts?: number;
  readonly startupRetryDelayMs?: number;
}

export interface IsolationGate {
  /** Runs the startup check and schedules periodic re-checks. */
  start(): Promise<IsolationStatus>;
  stop(): void;
  /** Re-checks now (concurrent callers share one Kubernetes API call). For display/ops. */
  check(): Promise<IsolationStatus>;
  /**
   * Last known state, for display only (admin console, logs, readiness). NOT valid for
   * authorisation: it may be up to a minute old. Agent work must use require().
   */
  status(): IsolationStatus;
  /**
   * The only gate for agent work: starts a fresh check (never joins one that began before this
   * call) and returns a VerifiedIsolation, or throws IsolationRuntimeMissingError.
   */
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
    apiTimeoutMs = ISOLATION_API_TIMEOUT_MS,
    startupAttempts = 1,
    startupRetryDelayMs = 2_000,
  } = options;

  let current: IsolationStatus =
    runtimeClassName === undefined
      ? { state: "missing", message: UNSET_MESSAGE, checkedAt: now() }
      : { state: "checking", runtimeClassName };
  let inFlight: Promise<IsolationStatus> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let reported = false;
  // Checks may overlap (require() never joins); a result only replaces a newer-started one's.
  let started = 0;
  let published = 0;

  const publish = (next: IsolationStatus, generation: number): IsolationStatus => {
    if (generation < published) return next;
    published = generation;
    const changed = !reported || !sameState(current, next);
    reported = true;
    current = next;
    if (changed) {
      try {
        onChange?.(next);
      } catch {
        // A failing listener (logger) must not break the gate; the state is already published.
      }
    }
    return next;
  };

  const evaluate = async (name: string): Promise<IsolationStatus> => {
    const result = await checkIsolation(
      () => withTimeout(listRuntimeClasses(), apiTimeoutMs),
      name,
    );
    const checkedAt = now();
    const [verified] = result.ok ? result.runtimeClasses : [];
    return verified
      ? { state: "verified", runtimeClassName: name, handler: verified.handler, checkedAt }
      : {
          state: "missing",
          runtimeClassName: name,
          message: result.ok ? "No isolating RuntimeClass found." : result.message,
          checkedAt,
        };
  };

  /** Never rejects: any failure becomes "missing" (fail closed). Does not publish. */
  const evaluateSafe = async (name: string): Promise<IsolationStatus> => {
    try {
      return await evaluate(name);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        state: "missing",
        runtimeClassName: name,
        message: `Isolation check failed (${reason}). ${ISOLATION_REMEDIATION}`,
        checkedAt: new Date(),
      };
    }
  };

  const runCheck = async (name: string): Promise<IsolationStatus> => {
    const generation = ++started;
    return publish(await evaluateSafe(name), generation);
  };

  /** Startup: retry a not-verified result (still "checking") before settling on it. */
  const startupCheck = async (name: string): Promise<IsolationStatus> => {
    const generation = ++started;
    let status = await evaluateSafe(name);
    for (let attempt = 1; attempt < startupAttempts && status.state !== "verified"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, startupRetryDelayMs));
      status = await evaluateSafe(name);
    }
    return publish(status, generation);
  };

  const unset = (): IsolationStatus =>
    publish({ state: "missing", message: UNSET_MESSAGE, checkedAt: now() }, ++started);

  const check = (): Promise<IsolationStatus> => {
    if (runtimeClassName === undefined) return Promise.resolve(unset());
    inFlight ??= runCheck(runtimeClassName).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return {
    start() {
      // Scheduled before the first check, so re-checks happen whatever that check does.
      timer ??= setInterval(() => void check(), recheckIntervalMs); // check() never rejects
      timer.unref();
      if (runtimeClassName === undefined || startupAttempts <= 1) return check();
      inFlight ??= startupCheck(runtimeClassName).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    check,
    status: () => current,
    async require() {
      // Its own check, started now: an in-flight one may predate this call by up to the timeout.
      const status = runtimeClassName === undefined ? unset() : await runCheck(runtimeClassName);
      if (status.state === "verified") {
        return VerifiedIsolation[MINT](status.runtimeClassName, status.handler);
      }
      throw new IsolationRuntimeMissingError(
        status.state === "missing" ? status.message : "isolation has not been verified yet",
      );
    },
  };
}
