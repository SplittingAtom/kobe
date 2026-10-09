import { injectTraceHeaders } from "@kobe/telemetry";
import { z } from "zod";
import type { GrantAnswer } from "./credentials.js";

/**
 * The proxy's client for the server's internal listener (`services/server/src/routes/internal.ts`):
 * the server authenticates the sandbox from its own token and decides every call (D27, D29). Any
 * failure to reach the server or to understand its answer is a refusal (fail closed).
 */

const annotationsSchema = z
  .object({
    title: z.string().optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  })
  .optional();

const pinnedToolSchema = z.object({
  name: z.string(),
  pi_name: z.string(),
  title: z.string().optional(),
  description: z.string(),
  input_schema: z.record(z.string(), z.unknown()),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  annotations: annotationsSchema,
});
export type ExposedTool = z.infer<typeof pinnedToolSchema>;

const toolsResponseSchema = z.object({
  connector: z.object({ id: z.string(), name: z.string() }),
  tools: z.array(pinnedToolSchema),
});
export type ToolsResponse = z.infer<typeof toolsResponseSchema>;

const decisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("allow"),
    connector: z.object({
      id: z.string(),
      name: z.string(),
      url: z.string(),
      auth_kind: z.enum(["oauth", "api_key", "none"]),
    }),
    tool: z.object({ name: z.string(), pi_name: z.string() }),
    input_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    reason: z.string(),
    approval_id: z.string().optional(),
  }),
  z.object({
    decision: z.literal("deny"),
    code: z.string(),
    message: z.string(),
    approval_failure: z.string().optional(),
  }),
]);
export type CallDecision = z.infer<typeof decisionSchema>;

export interface CallQuery {
  readonly connectorId: string;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly threadId?: string;
  readonly toolCallId?: string;
}

/** Why the server would not answer: the sandbox is not (or no longer) allowed, or not reachable. */
export type ServerFailure = "sandbox_unauthorized" | "not_available" | "unavailable";

export type ServerAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ServerFailure };

const grantSchema = z.object({ kind: z.literal("api_key"), api_key: z.string().min(1) });

export interface PolicyServer {
  listTools(token: string, connectorId: string): Promise<ServerAnswer<ToolsResponse>>;
  decide(token: string, query: CallQuery): Promise<ServerAnswer<CallDecision>>;
  /** The sandbox's own user's API key for a connector (KOBE-108); never cached. */
  fetchGrant(token: string, connectorId: string): Promise<GrantAnswer>;
}

export interface PolicyServerOptions {
  readonly baseUrl: string;
  readonly internalKey: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
  readonly onError?: (error: unknown) => void;
}

export function createPolicyServer(options: PolicyServerOptions): PolicyServer {
  const doFetch = options.fetch ?? fetch;

  async function post<T>(
    path: string,
    token: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<ServerAnswer<T>> {
    try {
      const res = await doFetch(`${options.baseUrl}/internal/v1/mcp${path}`, {
        method: "POST",
        headers: injectTraceHeaders({
          authorization: `Bearer ${options.internalKey}`,
          "kobe-sandbox-token": token,
          "content-type": "application/json",
        }),
        body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs),
        redirect: "error",
      });
      if (res.status === 401) {
        const json = (await res.json().catch(() => ({}))) as { code?: unknown };
        // Our own key refused is an operator problem, not the sandbox's.
        return {
          ok: false,
          failure: json.code === "sandbox_unauthorized" ? "sandbox_unauthorized" : "unavailable",
        };
      }
      if (res.status === 404) {
        await res.body?.cancel();
        return { ok: false, failure: "not_available" };
      }
      if (res.status !== 200) {
        await res.body?.cancel();
        throw new Error(`server answered ${res.status}`);
      }
      const parsed = schema.safeParse(await res.json());
      if (!parsed.success) throw new Error("server answer failed the schema");
      return { ok: true, value: parsed.data };
    } catch (error) {
      options.onError?.(error);
      return { ok: false, failure: "unavailable" };
    }
  }

  async function fetchGrant(token: string, connectorId: string): Promise<GrantAnswer> {
    try {
      const res = await doFetch(
        `${options.baseUrl}/internal/v1/mcp/connectors/${encodeURIComponent(connectorId)}/grant`,
        {
          method: "POST",
          headers: injectTraceHeaders({
            authorization: `Bearer ${options.internalKey}`,
            "kobe-sandbox-token": token,
          }),
          signal: AbortSignal.timeout(options.timeoutMs),
          redirect: "error",
        },
      );
      if (res.status === 404) {
        const json = (await res.json().catch(() => ({}))) as { code?: unknown };
        return {
          ok: false,
          failure: json.code === "not_connected" ? "not_connected" : "unavailable",
        };
      }
      if (res.status !== 200) {
        await res.body?.cancel();
        return { ok: false, failure: "unavailable" };
      }
      const parsed = grantSchema.safeParse(await res.json());
      if (!parsed.success) return { ok: false, failure: "unavailable" };
      return { ok: true, value: { kind: "api_key", apiKey: parsed.data.api_key } };
    } catch (error) {
      options.onError?.(error);
      return { ok: false, failure: "unavailable" };
    }
  }

  return {
    fetchGrant,
    listTools: (token, connectorId) =>
      post(
        `/connectors/${encodeURIComponent(connectorId)}/tools`,
        token,
        undefined,
        toolsResponseSchema,
      ),
    decide: (token, query) =>
      post(
        `/connectors/${encodeURIComponent(query.connectorId)}/calls`,
        token,
        {
          tool: query.tool,
          arguments: query.arguments,
          ...(query.threadId === undefined ? {} : { thread_id: query.threadId }),
          ...(query.toolCallId === undefined ? {} : { tool_call_id: query.toolCallId }),
        },
        decisionSchema,
      ),
  };
}
