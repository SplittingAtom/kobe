import type { IncomingHttpHeaders } from "node:http";
import { isDeepStrictEqual } from "node:util";
import {
  RUN_TOKEN_HEADER,
  SERVER_CALL_LIMITS,
  SERVER_CALL_PATH,
  SERVER_CALL_RESPONSE_FORMATS,
  SERVER_CALL_TOKEN_HEADER,
  serverCallOutputCap,
  serverCallRequestSchema,
  type ServerCallClaims,
  type ServerCallTokenPurpose,
} from "@kobe/protocol";
import { verifyServerCallToken, type SessionVerifyKeys } from "@kobe/session-token";
import type { ServerCallRunClaim } from "@kobe/db";
import { CREDENTIAL_HEADERS } from "./credentials.js";
import type { CallLimiter, RequestRate } from "./limits.js";
import type { Route } from "./routes.js";

/**
 * Server-originated model calls (KOBE-234; contract in `@kobe/protocol` server-call.ts, design in
 * docs/design/server-model-calls.md). A request carrying {@link SERVER_CALL_TOKEN_HEADER} is a
 * server call and nothing else: the header alone (no API-key header, `?key=`, run token or run id
 * beside it), a verified token never used before on this replica, the one route, and a body of the
 * contract's shape naming the token's model within its output cap. The member, enabled models,
 * budgets (with the purpose's soft limit) and the usage row then follow the sandbox path.
 */
export interface ServerCallOptions {
  /** Public key(s) of the model-gateway pair (KOBE-521): only the server can sign a token. */
  readonly keys: SessionVerifyKeys;
  readonly replay: ServerCallReplay;
  /**
   * The token's run is a completed run of its thread, leased to its member (review L1): one
   * indexed read (`serverCallRunMatches`), so a server bug cannot charge another member.
   */
  readonly runMatches: (claim: ServerCallRunClaim) => Promise<boolean>;
  /**
   * Server calls' own request rate and concurrency, per team (review L4): a team whose sandboxes
   * are busy still gets its titles, and server calls cannot crowd out its sandboxes.
   */
  readonly limiter: CallLimiter;
  readonly rate: RequestRate;
}

/** Defaults for {@link ServerCallOptions} limits, per team: about one call per completed run. */
export const SERVER_CALL_LIMIT_DEFAULTS = {
  concurrentPerTeam: 8,
  concurrentTotal: 64,
  burstPerTeam: 20,
  perSecondPerTeam: 5,
} as const;

/**
 * Single use per replica: a `jti` is refused once seen, until its token expires. Bounded: past
 * `maxEntries` live entries a new token is refused (fail closed) rather than forgetting one.
 */
export class ServerCallReplay {
  private readonly seen = new Map<string, number>();

  constructor(private readonly maxEntries = 100_000) {}

  /** True when `jti` was unused (it is now used); false for a replay or a full table. */
  claim(jti: string, expSeconds: number, nowSeconds: number): boolean {
    if (this.seen.size >= this.maxEntries) this.prune(nowSeconds);
    if (this.seen.has(jti) || this.seen.size >= this.maxEntries) return false;
    this.seen.set(jti, expSeconds);
    return true;
  }

  private prune(nowSeconds: number): void {
    for (const [jti, exp] of this.seen) if (exp <= nowSeconds) this.seen.delete(jti);
  }
}

export type ServerCallRefusal = {
  readonly ok: false;
  readonly status: 400 | 401 | 403;
  readonly code: string;
  readonly message: string;
};

const refuse = (status: 400 | 401 | 403, code: string, message: string): ServerCallRefusal => ({
  ok: false,
  status,
  code,
  message,
});

const INVALID = refuse(401, "invalid_server_call_token", "A valid server call token is required.");

/** Whether the request presents itself as a server call (the header, in any form). */
export function isServerCall(headers: IncomingHttpHeaders): boolean {
  return headers[SERVER_CALL_TOKEN_HEADER] !== undefined;
}

export function authenticateServerCall(
  options: ServerCallOptions | undefined,
  headers: IncomingHttpHeaders,
  search: URLSearchParams,
  route: Route | undefined,
  method: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { readonly ok: true; readonly claims: ServerCallClaims } | ServerCallRefusal {
  const sandboxCredential =
    CREDENTIAL_HEADERS.some((h) => headers[h] !== undefined) ||
    search.has("key") ||
    headers[RUN_TOKEN_HEADER] !== undefined ||
    headers["x-kobe-run-id"] !== undefined;
  if (sandboxCredential) {
    return refuse(
      400,
      "ambiguous_credentials",
      "A server call carries its server call token and no other credential.",
    );
  }
  const presented = headers[SERVER_CALL_TOKEN_HEADER];
  if (!options || typeof presented !== "string") return INVALID;
  const verified = verifyServerCallToken(options.keys, presented.trim(), nowSeconds);
  if (!verified.ok) return INVALID;
  const { claims } = verified;
  if (!options.replay.claim(claims.jti, claims.exp, nowSeconds)) {
    return refuse(401, "server_call_token_replayed", "That server call token was already used.");
  }
  if (method !== "POST" || route?.path !== SERVER_CALL_PATH) {
    return refuse(
      403,
      "server_call_route_refused",
      `A server call may only use POST ${SERVER_CALL_PATH}.`,
    );
  }
  return { ok: true, claims };
}

/**
 * The most a server call's body may hold: its purpose's cap (the eval judge's is larger, KOBE-326),
 * never above the gateway's own.
 */
export function serverCallBodyLimit(maxBodyBytes: number, purpose: ServerCallTokenPurpose): number {
  return Math.min(maxBodyBytes, SERVER_CALL_LIMITS[purpose].max_body_bytes);
}

/** The structured-output format the purpose may ask for, if any (only the judge's verdict). */
const formatOf = (purpose: ServerCallTokenPurpose): unknown =>
  (SERVER_CALL_RESPONSE_FORMATS as Partial<Record<ServerCallTokenPurpose, unknown>>)[purpose];

/**
 * The body against the contract and the token: shape (no tools, no streaming), the token's model,
 * an output limit within the token's and within the purpose's cap for this model: the reasoning
 * headroom and a `reasoning_effort` only when the site catalog marks the model as reasoning
 * (KOBE-219), whatever the token says; each message within the purpose's length; a
 * `response_format` only as exactly the purpose's own (the eval judge's verdict schema, KOBE-326).
 * Returns the output limit (the budget reservation's allowance).
 */
export function checkServerCallBody(
  body: Buffer,
  claims: ServerCallClaims,
  /** The catalog marks `claims.model` as reasoning (`GatewayPrincipal.reasoningModels`). */
  reasoning: boolean,
): { readonly ok: true; readonly maxOutputTokens: number } | ServerCallRefusal {
  const bad = (message: string) => refuse(400, "server_call_body_refused", message);
  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    return bad("The body must be JSON.");
  }
  const parsed = serverCallRequestSchema.safeParse(json);
  if (!parsed.success) {
    return bad("A server call is a plain chat completion: no tools, no streaming, text only.");
  }
  if (parsed.data.model !== claims.model) return bad("The model is not the token's.");
  const maxChars = SERVER_CALL_LIMITS[claims.purpose].max_message_chars;
  if (parsed.data.messages.some((m) => m.content.length > maxChars)) {
    return bad("A message is longer than the purpose allows.");
  }
  // The judge samples at its fixed temperature (0) or not at all (KOBE-326 review L4): the
  // author's run and the Registry re-run must agree.
  if (
    claims.purpose === "eval_judge" &&
    parsed.data.temperature !== SERVER_CALL_LIMITS.eval_judge.temperature
  ) {
    return bad("The eval judge runs at temperature 0.");
  }
  const format = parsed.data.response_format;
  if (format !== undefined && !isDeepStrictEqual(format, formatOf(claims.purpose))) {
    return bad("This purpose may not ask for that response format.");
  }
  const limit = parsed.data.max_tokens ?? parsed.data.max_completion_tokens ?? Infinity;
  if (limit > claims.max_output_tokens) return bad("The output limit is above the token's.");
  if (limit > serverCallOutputCap(claims.purpose, reasoning)) {
    return bad("The output limit is above this model's cap for the purpose.");
  }
  if (parsed.data.reasoning_effort !== undefined && !reasoning) {
    return bad("A reasoning effort is only for a model the catalog marks as reasoning.");
  }
  return { ok: true, maxOutputTokens: limit };
}
