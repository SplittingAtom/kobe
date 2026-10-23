/**
 * Whether the web was redeployed under an open tab (KOBE-487). The page knows its own build id
 * (`build-id.ts`) and asks `/api/build` for the one now served: when the tab becomes visible or
 * gains focus, every ten minutes, when the chat meets an event or tool this client doesn't know
 * (`noteUnknownInput`), and at once when a code chunk failed to load. Requests are throttled; a
 * different id makes the watcher stale for good, and the banner (`new-build-banner.tsx`) offers a
 * reload. Nothing here ever reloads the page.
 */

export const BUILD_ENDPOINT = "/api/build";
export const PERIODIC_CHECK_MS = 10 * 60_000;
/** At most one request per this gap, except after a failed chunk load. */
export const MIN_CHECK_GAP_MS = 30_000;

export type BuildCheckReason = "visible" | "periodic" | "unknown-input" | "chunk-error";

export interface BuildWatcherDeps {
  /** The page's own build id. */
  readonly current: string;
  /** The served build's id, or undefined when it could not be read. */
  readonly fetchBuildId: () => Promise<string | undefined>;
  readonly now: () => number;
}

export interface BuildWatcher {
  /** Asks (unless throttled) and resolves whether a newer build is served. */
  check(reason: BuildCheckReason): Promise<boolean>;
  isStale(): boolean;
  /** A code chunk the page needs failed to load: only a reload helps, whatever is served. */
  markStale(): void;
  subscribe(listener: () => void): () => void;
}

export function createBuildWatcher(deps: BuildWatcherDeps): BuildWatcher {
  let stale = false;
  let lastCheck: number | undefined;
  let inflight: Promise<boolean> | undefined;
  const listeners = new Set<() => void>();

  const markStale = () => {
    if (stale) return;
    stale = true;
    for (const listener of [...listeners]) listener();
  };

  const ask = async (reason: BuildCheckReason): Promise<boolean> => {
    lastCheck = deps.now();
    const served = await deps.fetchBuildId();
    // After a failed chunk load an unreachable endpoint most likely means a deploy is rolling.
    const newer = served === undefined ? reason === "chunk-error" : served !== deps.current;
    if (newer) markStale();
    return stale;
  };

  return {
    check(reason) {
      if (stale) return Promise.resolve(true);
      if (inflight !== undefined) return inflight;
      const throttled =
        reason !== "chunk-error" &&
        lastCheck !== undefined &&
        deps.now() - lastCheck < MIN_CHECK_GAP_MS;
      if (throttled) return Promise.resolve(false);
      inflight = ask(reason).finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
    isStale: () => stale,
    markStale,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The served build's id from `/api/build`, or undefined on any failure. */
export async function fetchBuildId(): Promise<string | undefined> {
  try {
    const res = await fetch(BUILD_ENDPOINT, { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    const id = (body as { buildId?: unknown } | null)?.buildId;
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
}

const CHUNK_MESSAGE =
  /Loading (CSS )?chunk [\w-]+ failed|Failed to load chunk|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

/** A webpack/Turbopack chunk or a dynamic `import()` that failed to load (a deploy removed it). */
export function isChunkLoadError(value: unknown): boolean {
  if (!(value instanceof Error)) return false;
  return value.name === "ChunkLoadError" || CHUNK_MESSAGE.test(value.message);
}

/** A Next.js static script or stylesheet whose load failed (an `error` event on the element). */
function isFailedChunkElement(target: EventTarget | null): boolean {
  const url =
    target instanceof HTMLScriptElement
      ? target.src
      : target instanceof HTMLLinkElement
        ? target.href
        : "";
  return url.includes("/_next/static/");
}

/**
 * Starts the checks on `win`: visibility, focus, the periodic timer and failed chunk loads.
 * Returns the function that stops them.
 */
export function watchForNewBuild(win: Window, watcher: BuildWatcher): () => void {
  const doc = win.document;
  const onVisible = () => {
    if (doc.visibilityState !== "hidden") void watcher.check("visible");
  };
  const onError = (event: Event) => {
    const error = event instanceof ErrorEvent ? event.error : undefined;
    if (isFailedChunkElement(event.target) || isChunkLoadError(error)) {
      void watcher.check("chunk-error");
    }
  };
  const onRejection = (event: Event) => {
    if (isChunkLoadError((event as PromiseRejectionEvent).reason)) {
      void watcher.check("chunk-error");
    }
  };
  const timer = win.setInterval(() => void watcher.check("periodic"), PERIODIC_CHECK_MS);
  doc.addEventListener("visibilitychange", onVisible);
  win.addEventListener("focus", onVisible);
  // Capture: a failed <script>/<link> load does not bubble.
  win.addEventListener("error", onError, true);
  win.addEventListener("unhandledrejection", onRejection);
  return () => {
    win.clearInterval(timer);
    doc.removeEventListener("visibilitychange", onVisible);
    win.removeEventListener("focus", onVisible);
    win.removeEventListener("error", onError, true);
    win.removeEventListener("unhandledrejection", onRejection);
  };
}

let active: BuildWatcher | undefined;

/** The watcher `noteUnknownInput` and the error pages ask (set by the banner while mounted). */
export function setActiveWatcher(watcher: BuildWatcher | undefined): void {
  active = watcher;
}

/**
 * The chat met an event type or tool this client doesn't know: the web may have been redeployed
 * with it, so check (throttled). Nothing happens before the banner mounted.
 */
export function noteUnknownInput(): void {
  void active?.check("unknown-input");
}

/** A failed chunk load broke part of the page (an error page caught it): offer the reload. */
export function noteChunkLoadError(): void {
  active?.markStale();
}
