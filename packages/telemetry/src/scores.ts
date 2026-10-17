import type { TelemetryConfig } from "./config.js";

/**
 * Trace scores (KOBE-275): a member's rating of an answer, sent to the tracing backend as a score
 * on the run's trace. OTLP has no scores, so this speaks Langfuse's public scores API with the
 * exporter's own endpoint and headers: on only when `KOBE_OTEL_ENDPOINT` is a Langfuse OTLP
 * endpoint (`…/api/public/otel`), off for every other backend. The server calls it; nothing in a
 * sandbox holds the endpoint or the credential.
 *
 * A score is upserted by `id` (Langfuse updates a score sent again with the same id), so a changed
 * rating replaces its score and a cleared one is deleted by the same id.
 */

/** One score; metadata holds ids, codes and numbers only (callers keep text out unless capture is on). */
export interface TraceScore {
  readonly id: string;
  /** 32 lowercase hex digits (the run's trace id). */
  readonly traceId: string;
  readonly name: string;
  readonly dataType: "BOOLEAN";
  readonly value: 0 | 1;
  readonly comment?: string;
  readonly metadata: Readonly<Record<string, string | number | null | readonly string[]>>;
}

export interface ScoreSink {
  upsert(score: TraceScore): Promise<void>;
  /** Deleting a score that isn't there succeeds. */
  remove(id: string): Promise<void>;
}

const LANGFUSE_OTEL_PATH = "/api/public/otel";
const DEFAULT_TIMEOUT_MS = 10_000;

/** The scores endpoint of a Langfuse OTLP endpoint, else undefined (not Langfuse: no scores). */
export function langfuseScoresUrl(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined) return undefined;
  const url = new URL(endpoint);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith(LANGFUSE_OTEL_PATH)) return undefined;
  url.pathname = `${path.slice(0, -LANGFUSE_OTEL_PATH.length)}/api/public/scores`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export interface ScoreSinkOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Thrown on a failed call; carries the status only (never the URL's credentials or headers). */
export class ScoreExportError extends Error {
  constructor(
    readonly operation: "upsert" | "remove",
    readonly status: number | null,
  ) {
    super(`trace score ${operation} failed${status === null ? "" : ` (HTTP ${status})`}`);
    this.name = "ScoreExportError";
  }
}

/** The Langfuse score sink for this exporter configuration, or undefined when it has none. */
export function createLangfuseScoreSink(
  config: Pick<TelemetryConfig, "enabled" | "endpoint" | "headers">,
  options: ScoreSinkOptions = {},
): ScoreSink | undefined {
  if (!config.enabled) return undefined;
  const base = langfuseScoresUrl(config.endpoint);
  if (base === undefined) return undefined;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = { ...config.headers };
  const call = async (
    operation: "upsert" | "remove",
    url: string,
    init: RequestInit,
    ok: (status: number) => boolean,
  ) => {
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new ScoreExportError(operation, null);
    }
    // Drain the body so the connection is reused; its content is never logged.
    await res.arrayBuffer().catch(() => undefined);
    if (!ok(res.status)) throw new ScoreExportError(operation, res.status);
  };
  return {
    upsert: (score) =>
      call(
        "upsert",
        base,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(score),
        },
        (s) => s >= 200 && s < 300,
      ),
    remove: (id) =>
      call(
        "remove",
        `${base}/${encodeURIComponent(id)}`,
        { method: "DELETE", headers },
        (s) => (s >= 200 && s < 300) || s === 404,
      ),
  };
}
