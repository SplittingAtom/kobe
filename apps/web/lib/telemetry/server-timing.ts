import { randomUUID } from "node:crypto";
import { subscribe as subscribeChannel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";

/**
 * `Server-Timing` on every HTML response (KOBE-530 ac-1), so a slow first byte says where the time
 * went: `app` (the web's own time from the request to the response headers: proxy, loading the
 * route's modules, the render up to the first byte), `branding` (how long the root layout waited
 * on the site branding, lib/theme/branding-server.ts) and `cold` on the first page this web process
 * serves (Next loads the app's server modules on that request). Browsers expose it as
 * `PerformanceNavigationTiming.serverTiming`, so lab runs and DevTools read it with no extra code.
 *
 * Next has no supported way for a render to set a response header (the proxy runs before it), so
 * `instrumentation.ts` enables this once per process: a `diagnostics_channel` subscriber on
 * Node's `http.server.request.start` gives each request an id (request header
 * {@link TIMING_ID_HEADER}, always replaced, so a client cannot pick one), the render adds metrics
 * under that id ({@link recordServerTiming}), and the header is set just before the response's
 * headers are written. Values are durations only, never data.
 */

export const TIMING_ID_HEADER = "x-kobe-timing-id";
const REGISTRY = Symbol.for("kobe.web.serverTiming");
const ENABLED = Symbol.for("kobe.web.serverTimingEnabled");
const CHANNEL = "http.server.request.start";

/** The parts of Node's IncomingMessage / ServerResponse this uses (tests pass fakes). */
export interface TimedRequest {
  readonly headers: Record<string, string | string[] | undefined>;
}
export interface TimedResponse {
  getHeader(name: string): unknown;
  setHeader(name: string, value: string): unknown;
  writeHead(...args: unknown[]): unknown;
  once(event: "close", listener: () => void): unknown;
}

export interface ServerTimingOptions {
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly subscribe?: (name: string, onMessage: (message: unknown) => void) => void;
}

/**
 * Pending metrics per request id. On globalThis: the instrumentation and the app's server bundles
 * are separate module graphs in one process.
 */
function registry(): Map<string, string[]> {
  const g = globalThis as { [REGISTRY]?: Map<string, string[]> };
  g[REGISTRY] ??= new Map();
  return g[REGISTRY];
}

/** One Server-Timing metric: `name;dur=1.2;desc="…"`. */
export function formatMetric(name: string, durMs?: number, desc?: string): string {
  const dur = durMs === undefined ? "" : `;dur=${durMs.toFixed(1)}`;
  return `${name}${dur}${desc === undefined ? "" : `;desc="${desc}"`}`;
}

/** Adds a metric to this request's Server-Timing; a no-op outside a timed request. */
export function recordServerTiming(requestHeaders: Headers, name: string, durMs: number): void {
  const id = requestHeaders.get(TIMING_ID_HEADER);
  if (id === null) return;
  registry().get(id)?.push(formatMetric(name, durMs));
}

function contentTypeOf(response: TimedResponse, args: readonly unknown[]): string {
  const set = response.getHeader("content-type");
  if (typeof set === "string") return set;
  const headers = args.find(
    (a): a is Record<string, unknown> => typeof a === "object" && a !== null && !Array.isArray(a),
  );
  const key =
    headers === undefined
      ? undefined
      : Object.keys(headers).find((k) => k.toLowerCase() === "content-type");
  const value = key === undefined ? undefined : headers?.[key];
  return typeof value === "string" ? value : "";
}

/** The subscriber itself, with its own "first page" state; exported for tests. */
export function createServerTiming(options: ServerTimingOptions = {}): void {
  const now = options.now ?? (() => performance.now());
  const newId = options.newId ?? randomUUID;
  const subscribe = options.subscribe ?? subscribeChannel;
  let firstPage = true;

  const onRequest = (request: TimedRequest, response: TimedResponse): void => {
    const started = now();
    const id = newId();
    request.headers[TIMING_ID_HEADER] = id;
    const marks: string[] = [];
    registry().set(id, marks);
    response.once("close", () => registry().delete(id));
    const writeHead = response.writeHead.bind(response);
    response.writeHead = (...args: unknown[]) => {
      if (registry().get(id) === marks) {
        registry().delete(id);
        if (contentTypeOf(response, args).startsWith("text/html")) {
          const metrics = [
            ...marks,
            formatMetric("app", now() - started, "server time to first byte"),
          ];
          if (firstPage)
            metrics.push(formatMetric("cold", undefined, "first page of this web process"));
          firstPage = false;
          response.setHeader("server-timing", metrics.join(", "));
        }
      }
      return writeHead(...args);
    };
  };

  subscribe(CHANNEL, (message) => {
    const { request, response } = message as { request?: TimedRequest; response?: TimedResponse };
    if (request !== undefined && response !== undefined) onRequest(request, response);
  });
}

/** Enables the subscriber once per process (`instrumentation.ts`, Node runtime only). */
export function enableServerTiming(): void {
  const g = globalThis as { [ENABLED]?: true };
  if (g[ENABLED]) return;
  g[ENABLED] = true;
  createServerTiming();
}
