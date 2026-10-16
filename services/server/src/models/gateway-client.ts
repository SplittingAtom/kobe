import { randomUUID } from "node:crypto";
import {
  MAX_SERVER_CALL_TOKEN_TTL_SECONDS,
  SERVER_CALL_AUDIENCE,
  SERVER_CALL_LIMITS,
  SERVER_CALL_PATH,
  SERVER_CALL_TOKEN_HEADER,
  serverCallRequestSchema,
  type ServerCallPurpose,
  type ServerCallRequest,
} from "@kobe/protocol";
import { deriveServerCallTokenKey, signServerCallToken } from "@kobe/protocol/node";
import { SpanKind, idAttributes, injectTraceHeaders, withSpan } from "@kobe/telemetry";

/**
 * The server's own model calls (KOBE-219 titles, KOBE-222 follow-ups) through the model gateway,
 * per the KOBE-234 contract (docs/design/server-model-calls.md): one `POST /v1/chat/completions`
 * per call, authenticated by a server-call token minted right before it (TTL 30 s, bound to the
 * purpose, team, member, thread, run, model and output cap) in `x-kobe-server-call`, alone. No
 * session token, run token, run id or provider key is ever sent: the gateway forwards with the
 * member's virtual key, as for sandbox calls. Non-streaming, no retries, no redirects; the caller's
 * signal bounds the whole call. Failures carry a short code only (the gateway's, or the status),
 * never response text.
 */

/** The env var the gateway's session key comes from (the server already holds it, KOBE-118). */
const MASTER_ENV = "KOBE_SESSION_KEY_MODEL_GATEWAY";
/** Largest reply read (a title or three follow-ups are far smaller). */
const MAX_REPLY_BYTES = 64 * 1024;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** The server-call token key (HKDF of the gateway session key); undefined when unset or short. */
export function serverCallKeyFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): Uint8Array | undefined {
  const master = env[MASTER_ENV];
  if (!master) return undefined;
  try {
    return deriveServerCallTokenKey(new TextEncoder().encode(master));
  } catch {
    return undefined;
  }
}

/** A failed server call: `code` is safe to log (no content, no credentials). */
export class ServerCallError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(`server call failed: ${code}`, options);
    this.name = "ServerCallError";
  }
}

export interface ServerCallInput {
  readonly purpose: ServerCallPurpose;
  readonly teamId: string;
  /** The member whose run triggered the call (budget line and virtual key). */
  readonly userId: string;
  readonly threadId: string;
  /** The completed run that triggered the call. */
  readonly runId: string;
  /** `<gateway provider>/<model>`: the thread's resolved model. */
  readonly model: string;
  readonly messages: ServerCallRequest["messages"];
  /** Bounds the whole call (the purpose's `timeout_ms`, from the epilogue). */
  readonly signal: AbortSignal;
}

export interface ServerCallClient {
  /** The reply's text (first choice); throws {@link ServerCallError}. */
  complete(input: ServerCallInput): Promise<string>;
}

export interface ServerCallClientOptions {
  /** The gateway's in-cluster origin (`KOBE_MODEL_GATEWAY_URL`). */
  readonly url: string;
  /** From {@link serverCallKeyFromEnv}. */
  readonly key: Uint8Array;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

function mintToken(key: Uint8Array, input: ServerCallInput, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  return signServerCallToken(key, {
    iss: "kobe-server",
    aud: SERVER_CALL_AUDIENCE,
    purpose: input.purpose,
    team_id: input.teamId,
    user_id: input.userId,
    thread_id: input.threadId,
    run_id: input.runId,
    model: input.model,
    max_output_tokens: SERVER_CALL_LIMITS[input.purpose].max_output_tokens,
    iat,
    exp: iat + MAX_SERVER_CALL_TOKEN_TTL_SECONDS,
    jti: randomUUID(),
  });
}

function bodyOf(input: ServerCallInput): ServerCallRequest {
  return serverCallRequestSchema.parse({
    model: input.model,
    messages: input.messages,
    max_tokens: SERVER_CALL_LIMITS[input.purpose].max_output_tokens,
    temperature: 0.2,
    stream: false,
  });
}

/** Reads at most MAX_REPLY_BYTES of the body; undefined when it is longer or unreadable. */
async function readCapped(res: Response): Promise<string | undefined> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REPLY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The gateway's refusal code (OpenAI shape `{error: {code | type}}`), else the status. */
function refusalCode(json: unknown, status: number): string {
  const error = (json as { error?: { code?: unknown; type?: unknown } } | undefined)?.error;
  const code = typeof error?.code === "string" ? error.code : error?.type;
  return typeof code === "string" && CODE.test(code) ? code : `http_${status}`;
}

function replyText(json: unknown): string | undefined {
  const choices = (json as { choices?: unknown } | undefined)?.choices;
  const message = Array.isArray(choices)
    ? (choices[0] as { message?: { content?: unknown } } | undefined)?.message
    : undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((p: { type?: unknown; text?: unknown }) =>
      p?.type === "text" && typeof p.text === "string" ? p.text : "",
    )
    .join("");
  return text === "" ? undefined : text;
}

async function post(
  doFetch: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await doFetch(url, { method: "POST", headers, body, signal, redirect: "manual" });
  } catch (err) {
    throw new ServerCallError(signal.aborted ? "timeout" : "unreachable", undefined, {
      cause: err,
    });
  }
}

export function createServerCallClient(options: ServerCallClientOptions): ServerCallClient {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const endpoint = new URL(SERVER_CALL_PATH, options.url).toString();
  return {
    complete(input) {
      const ids = {
        teamId: input.teamId,
        userId: input.userId,
        threadId: input.threadId,
        runId: input.runId,
      };
      return withSpan(
        `server_call.${input.purpose}`,
        {
          kind: SpanKind.CLIENT,
          attributes: { ...idAttributes(ids), "kobe.usage_kind": input.purpose },
        },
        async () => {
          const body = JSON.stringify(bodyOf(input));
          // Minted right before the call, sent once, never stored or logged.
          const headers = injectTraceHeaders({
            "content-type": "application/json",
            [SERVER_CALL_TOKEN_HEADER]: mintToken(options.key, input, now()),
          });
          const res = await post(doFetch, endpoint, headers, body, input.signal);
          let text: string | undefined;
          try {
            text = await readCapped(res);
          } catch {
            throw new ServerCallError(input.signal.aborted ? "timeout" : "unreadable", res.status);
          }
          const json = parseJson(text);
          if (!res.ok) throw new ServerCallError(refusalCode(json, res.status), res.status);
          const reply = replyText(json);
          if (reply === undefined) throw new ServerCallError("bad_reply", res.status);
          return reply;
        },
      );
    },
  };
}
