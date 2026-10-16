import { randomUUID } from "node:crypto";
import {
  MAX_SERVER_CALL_TOKEN_TTL_SECONDS,
  SERVER_CALL_AUDIENCE,
  SERVER_CALL_PATH,
  SERVER_CALL_REASONING_EFFORT,
  SERVER_CALL_TOKEN_HEADER,
  serverCallOutputCap,
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

/**
 * A failed server call: `code` is safe to log (no content, no credentials). A reply the call
 * cannot use is one too: `empty_content` (no text, e.g. a reasoning model spent its allowance
 * thinking), `truncated` (`finish_reason: length`: never saved, the text may stop mid-word),
 * `bad_reply` (not a chat completion); the epilogue adds `schema_reject` for text that does not
 * make a title. `model` is the call's model, for the log.
 */
export class ServerCallError extends Error {
  readonly model: string | undefined;

  constructor(
    readonly code: string,
    readonly status?: number,
    options?: ErrorOptions & { readonly model?: string },
  ) {
    super(`server call failed: ${code}`, options);
    this.name = "ServerCallError";
    this.model = options?.model;
  }

  /** The reply came back but cannot be used (logged as `server call skipped`, not a failure). */
  get unusable(): boolean {
    return UNUSABLE.has(this.code);
  }
}

/** Skips, not failures: an unusable reply, or nothing to call with (`threads/title-source.ts`). */
const UNUSABLE = new Set([
  "empty_content",
  "truncated",
  "bad_reply",
  "schema_reject",
  "titled",
  "no_thread",
  "no_lease",
  "no_model",
  "no_message",
]);

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
  /**
   * The site catalog marks the model as reasoning (`model_catalog.reasoning`): the call asks for
   * `reasoning_effort: low` and may use the purpose's reasoning headroom (KOBE-219 review H1).
   */
  readonly reasoning: boolean;
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
    max_output_tokens: serverCallOutputCap(input.purpose, input.reasoning),
    iat,
    exp: iat + MAX_SERVER_CALL_TOKEN_TTL_SECONDS,
    jti: randomUUID(),
  });
}

function bodyOf(input: ServerCallInput): ServerCallRequest {
  return serverCallRequestSchema.parse({
    model: input.model,
    messages: input.messages,
    max_tokens: serverCallOutputCap(input.purpose, input.reasoning),
    temperature: 0.2,
    stream: false,
    ...(input.reasoning ? { reasoning_effort: SERVER_CALL_REASONING_EFFORT } : {}),
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

type Reply = { readonly kind: "text"; readonly text: string } | { readonly kind: UnusableCode };
type UnusableCode = "empty_content" | "truncated" | "bad_reply";

/** The first choice's text, or why it cannot be used (never its content). */
function replyOf(json: unknown): Reply {
  const choices = (json as { choices?: unknown } | undefined)?.choices;
  const choice = Array.isArray(choices)
    ? (choices[0] as { message?: { content?: unknown }; finish_reason?: unknown } | undefined)
    : undefined;
  if (!choice?.message) return { kind: "bad_reply" };
  if (choice.finish_reason === "length") return { kind: "truncated" };
  const content = choice.message.content;
  if (content === null || content === undefined) return { kind: "empty_content" };
  if (typeof content !== "string" && !Array.isArray(content)) return { kind: "bad_reply" };
  const text =
    typeof content === "string"
      ? content
      : content
          .map((p: { type?: unknown; text?: unknown }) =>
            p?.type === "text" && typeof p.text === "string" ? p.text : "",
          )
          .join("");
  return text.trim() === "" ? { kind: "empty_content" } : { kind: "text", text };
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
            throw new ServerCallError(input.signal.aborted ? "timeout" : "unreadable", res.status, {
              model: input.model,
            });
          }
          const json = parseJson(text);
          const model = { model: input.model };
          if (!res.ok) throw new ServerCallError(refusalCode(json, res.status), res.status, model);
          const reply = replyOf(json);
          if (reply.kind !== "text") throw new ServerCallError(reply.kind, res.status, model);
          return reply.text;
        },
      );
    },
  };
}
