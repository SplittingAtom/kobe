import { z } from "zod";
import { readCapped } from "../connectors/probe.js";

/**
 * The server's client for mcp-proxy's `POST /internal/v1/app-calls` (KOBE-436): sends a call the
 * server already decided, with the member's credential, to the proxy over the internal port
 * (internal key). The credential goes only there; nothing about it comes back.
 */
export interface AppCallRequest {
  readonly connectorId: string;
  readonly url: string;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly credential?:
    | { readonly kind: "api_key"; readonly apiKey: string }
    | { readonly kind: "oauth"; readonly accessToken: string };
}

export type AppCallAnswer =
  | { readonly ok: true; readonly result: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly failure: string;
      readonly code?: number | undefined;
      readonly message?: string | undefined;
    };

export interface AppCaller {
  call(request: AppCallRequest): Promise<AppCallAnswer>;
}

const answerSchema = z.union([
  z.object({ ok: z.literal(true), result: z.record(z.string(), z.unknown()) }),
  z.object({
    ok: z.literal(false),
    failure: z.string().regex(/^[a-z_]{1,32}$/),
    code: z.number().int().optional(),
    message: z.string().max(1000).optional(),
  }),
]);

/** The proxy caps upstream answers at 4 MiB; the server reads a little more than that. */
export const APP_CALL_MAX_ANSWER_BYTES = 5 * 1024 * 1024;

export interface ProxyAppCallerOptions {
  readonly baseUrl: string;
  readonly internalKey: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

const UNAVAILABLE: AppCallAnswer = { ok: false, failure: "proxy_unavailable" };

export function createProxyAppCaller(options: ProxyAppCallerOptions): AppCaller {
  const doFetch = options.fetch ?? fetch;
  return {
    async call(request) {
      const credential =
        request.credential === undefined
          ? {}
          : request.credential.kind === "api_key"
            ? { api_key: request.credential.apiKey }
            : { access_token: request.credential.accessToken };
      try {
        const res = await doFetch(`${options.baseUrl}/internal/v1/app-calls`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.internalKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            connector_id: request.connectorId,
            url: request.url,
            tool: request.tool,
            arguments: request.arguments,
            ...credential,
          }),
          signal: AbortSignal.timeout(options.timeoutMs),
          redirect: "error",
        });
        if (res.status !== 200) {
          await res.body?.cancel();
          return UNAVAILABLE;
        }
        const text = await readCapped(res, APP_CALL_MAX_ANSWER_BYTES);
        if (text === undefined) return { ok: false, failure: "too_large" };
        const parsed = answerSchema.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },
  };
}

/** No proxy configured: every app call fails as unavailable. */
export const NO_APP_CALLER: AppCaller = { call: () => Promise.resolve(UNAVAILABLE) };
