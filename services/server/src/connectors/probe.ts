import { z } from "zod";

/**
 * The server's client for the MCP proxy's probe endpoint (KOBE-101): the proxy fetches a
 * connector's live `tools/list` under the address policy and size/time caps; the server only
 * pins what comes back. Any failure to reach or understand the proxy is `proxy_unavailable`.
 */
export type ProbeFailure =
  | "url_not_allowed"
  | "forbidden_address"
  | "unreachable"
  | "timeout"
  | "auth_required"
  | "http_error"
  | "protocol_error"
  | "too_large"
  | "rpc_error"
  | "proxy_unavailable";

export type ProbeResult =
  | { readonly ok: true; readonly tools: readonly unknown[] }
  | { readonly ok: false; readonly failure: ProbeFailure };

export interface ConnectorProbe {
  probe(url: string): Promise<ProbeResult>;
}

const FAILURES = [
  "url_not_allowed",
  "forbidden_address",
  "unreachable",
  "timeout",
  "auth_required",
  "http_error",
  "protocol_error",
  "too_large",
  "rpc_error",
] as const;

const answerSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), tools: z.array(z.unknown()) }),
  z.object({ ok: z.literal(false), failure: z.enum(FAILURES) }),
]);

/** The proxy caps an upstream call at 55 s by default; the server waits a little longer. */
export const PROBE_TIMEOUT_MS = 60_000;

export interface ProxyProbeOptions {
  /** The MCP proxy's base URL, e.g. http://kobe-mcp-proxy. */
  readonly baseUrl: string;
  readonly internalKey: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

export function createProxyProbe(options: ProxyProbeOptions): ConnectorProbe {
  const doFetch = options.fetch ?? fetch;
  return {
    async probe(url) {
      try {
        const res = await doFetch(`${options.baseUrl}/internal/v1/probe`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.internalKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ url }),
          signal: AbortSignal.timeout(options.timeoutMs),
          redirect: "error",
        });
        if (res.status !== 200) {
          await res.body?.cancel();
          return { ok: false, failure: "proxy_unavailable" };
        }
        const parsed = answerSchema.safeParse(await res.json());
        return parsed.success ? parsed.data : { ok: false, failure: "proxy_unavailable" };
      } catch {
        return { ok: false, failure: "proxy_unavailable" };
      }
    },
  };
}

/** Used when no proxy is configured: registering works, pinning reports it cannot run. */
export const NO_PROBE: ConnectorProbe = {
  probe: () => Promise.resolve({ ok: false, failure: "proxy_unavailable" }),
};
