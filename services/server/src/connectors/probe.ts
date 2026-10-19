import { z } from "zod";

/**
 * The server's client for the MCP proxy's probe endpoint (KOBE-101): the proxy fetches a
 * connector's live `tools/list` (and the `ui://` templates its tools name, KOBE-433) under the
 * address policy and size/time caps; the server only pins what comes back. Any failure to reach or understand the proxy is `proxy_unavailable`.
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
  | {
      readonly ok: true;
      readonly tools: readonly unknown[];
      /**
       * The `ui://` templates the tools name (KOBE-433), as the proxy read them (validated by
       * templates.ts). Absent when the prober did not report any (refresh then leaves them alone).
       */
      readonly uiResources?: readonly unknown[];
      /** The proxy skipped the template part (e.g. `resources/list` failed): templates stay. */
      readonly uiSkipped?: string;
    }
  | { readonly ok: false; readonly failure: ProbeFailure };

export interface ConnectorProbe {
  /** `apiKey`: the user's grant, for a connector that needs one (sent to the proxy, never stored). */
  probe(url: string, apiKey?: string): Promise<ProbeResult>;
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
  z.object({
    ok: z.literal(true),
    tools: z.array(z.unknown()),
    ui_resources: z.array(z.unknown()).optional(),
    ui_resources_skipped: z
      .string()
      .regex(/^[a-z_]{1,32}$/)
      .optional(),
  }),
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

/** Largest proxy answer the server reads (16 templates of 512 KiB plus tools fit well). */
export const PROBE_MAX_ANSWER_BYTES = 16 * 1024 * 1024;

/** The body as text, refusing more than `max` bytes while it streams. */
async function readCapped(res: Response, max: number): Promise<string | undefined> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createProxyProbe(options: ProxyProbeOptions): ConnectorProbe {
  const doFetch = options.fetch ?? fetch;
  const post = (body: Record<string, unknown>) =>
    doFetch(`${options.baseUrl}/internal/v1/probe`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.internalKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
      redirect: "error",
    });
  return {
    async probe(url, apiKey) {
      const base = { url, ...(apiKey === undefined ? {} : { api_key: apiKey }) };
      try {
        let res = await post({ ...base, ui_resources: true });
        // A proxy older than KOBE-433 refuses the field: probe the tools alone (review LOW-1);
        // without `uiResources` the refresh leaves the templates as they are.
        if (res.status === 400) {
          await res.body?.cancel();
          res = await post(base);
        }
        if (res.status !== 200) {
          await res.body?.cancel();
          return { ok: false, failure: "proxy_unavailable" };
        }
        const text = await readCapped(res, PROBE_MAX_ANSWER_BYTES);
        if (text === undefined) return { ok: false, failure: "too_large" };
        const parsed = answerSchema.safeParse(JSON.parse(text));
        if (!parsed.success) return { ok: false, failure: "proxy_unavailable" };
        if (!parsed.data.ok) return parsed.data;
        const { tools, ui_resources: uiResources, ui_resources_skipped: uiSkipped } = parsed.data;
        return {
          ok: true,
          tools,
          ...(uiResources === undefined ? {} : { uiResources }),
          ...(uiSkipped === undefined ? {} : { uiSkipped }),
        };
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
