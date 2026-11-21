import {
  MEMORY_EMBED_MAX_INPUTS,
  SERVER_CALL_EMBEDDINGS_PATH,
  SERVER_CALL_TOKEN_HEADER,
  embeddingsResponseSchema,
  serverCallEmbeddingsRequestSchema,
} from "@kobe/protocol";
import type { SessionSigningKey } from "@kobe/session-token";
import { SpanKind, idAttributes, injectTraceHeaders, withSpan } from "@kobe/telemetry";
import { ServerCallError, mintToken, parseJson, refusalCode } from "./gateway-client.js";
import { readCapped } from "../http/read-capped.js";

/**
 * The server's embedding calls (KOBE-409) through the model gateway: one `POST /v1/embeddings`
 * per call with a `memory_embed` server-call token minted right before it (TTL 30 s, bound to the
 * team, member, model and, for the selector's query embedding, the run being started). Nothing
 * else is sent: no session token, run token or provider key. Non-streaming, no retries, no
 * redirects; the caller's signal bounds the call. Failures carry a short code only.
 */

/** Largest reply read: 64 vectors of up to 4,096 floats as JSON. */
const MAX_REPLY_BYTES = 8 * 1024 * 1024;

export interface EmbedInput {
  readonly teamId: string;
  /** Who pays (the run's member, the person saving, or the Site admin running a backfill). */
  readonly userId: string;
  /** The run (and its thread) being started: the selector's query embedding only. */
  readonly run?: { readonly runId: string; readonly threadId: string };
  /** `<gateway provider>/<model>`: the Site embedding model. */
  readonly model: string;
  /** 1 to 64 texts (each at most 4,000 characters). */
  readonly inputs: readonly string[];
  readonly signal: AbortSignal;
}

export interface EmbeddingClient {
  /** One vector per input, in input order; throws {@link ServerCallError}. */
  embed(input: EmbedInput): Promise<number[][]>;
}

export interface EmbeddingClientOptions {
  readonly url: string;
  readonly key: SessionSigningKey;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

/** The vectors in input order, or why the reply cannot be used. */
export function vectorsOf(json: unknown, count: number): number[][] | "bad_reply" {
  const parsed = embeddingsResponseSchema.safeParse(json);
  if (!parsed.success || parsed.data.data.length !== count) return "bad_reply";
  const out: number[][] = new Array<number[]>(count);
  for (const d of parsed.data.data) {
    if (d.index >= count || out[d.index] !== undefined) return "bad_reply";
    out[d.index] = d.embedding;
  }
  const dims = out[0]?.length;
  return out.every((v) => v.length === dims) ? out : "bad_reply";
}

export function createEmbeddingClient(options: EmbeddingClientOptions): EmbeddingClient {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const endpoint = new URL(SERVER_CALL_EMBEDDINGS_PATH, options.url).toString();
  return {
    embed(input) {
      if (input.inputs.length === 0 || input.inputs.length > MEMORY_EMBED_MAX_INPUTS) {
        return Promise.reject(new ServerCallError("bad_request"));
      }
      return withSpan(
        "server_call.memory_embed",
        {
          kind: SpanKind.CLIENT,
          attributes: {
            ...idAttributes({
              teamId: input.teamId,
              userId: input.userId,
              runId: input.run?.runId,
              threadId: input.run?.threadId,
            }),
            "kobe.usage_kind": "memory_embed",
          },
        },
        async () => {
          const body = JSON.stringify(
            serverCallEmbeddingsRequestSchema.parse({
              model: input.model,
              input: [...input.inputs],
              encoding_format: "float",
            }),
          );
          const token = mintToken(
            options.key,
            {
              purpose: "memory_embed",
              teamId: input.teamId,
              userId: input.userId,
              ...(input.run ? { runId: input.run.runId, threadId: input.run.threadId } : {}),
              model: input.model,
              reasoning: false,
            },
            now(),
          );
          const headers = injectTraceHeaders({
            "content-type": "application/json",
            [SERVER_CALL_TOKEN_HEADER]: token,
          });
          let res: Response;
          try {
            res = await doFetch(endpoint, {
              method: "POST",
              headers,
              body,
              signal: input.signal,
              redirect: "manual",
            });
          } catch (err) {
            throw new ServerCallError(input.signal.aborted ? "timeout" : "unreachable", undefined, {
              cause: err,
            });
          }
          let text: string | undefined;
          try {
            text = await readCapped(res, MAX_REPLY_BYTES);
          } catch {
            throw new ServerCallError(input.signal.aborted ? "timeout" : "unreadable", res.status);
          }
          const json = parseJson(text);
          const model = { model: input.model };
          if (!res.ok) throw new ServerCallError(refusalCode(json, res.status), res.status, model);
          const vectors = vectorsOf(json, input.inputs.length);
          if (vectors === "bad_reply") throw new ServerCallError("bad_reply", res.status, model);
          return vectors;
        },
      );
    },
  };
}
