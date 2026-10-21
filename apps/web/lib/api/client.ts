/**
 * The one fetch wrapper for Kobe's API (same origin: the ingress routes `/v1` to the server).
 * It never throws for HTTP or network failures: callers get an `ApiResult` and render the error.
 * Authorization is the server's: a 403 here is the answer, whatever the UI showed.
 */
import { TEAM_HEADER } from "../teams";
import { camelizeKeys } from "./casing";

export interface ApiError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

export type ApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | { readonly ok: false; readonly error: ApiError };

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  readonly method?: HttpMethod | undefined;
  /** JSON body, sent exactly as given: resource modules write each route's wire casing. */
  readonly json?: unknown;
  /** A raw body (e.g. an agent markdown file) with its content type. */
  readonly raw?: { readonly body: string | Uint8Array; readonly contentType: string } | undefined;
  /** A multipart body (file upload); the browser sets the content type with its boundary. */
  readonly form?: FormData | undefined;
  /** The active team this request acts on (`X-Kobe-Team`, the server's stale-tab guard). */
  readonly teamId?: string | undefined;
  /** `If-Match` (an ETag such as `"3"`): agent edits and publishes (KOBE-45/46). */
  readonly ifMatch?: string | undefined;
  /** `Idempotency-Key`: makes a create safe to repeat (`POST /v1/threads/{id}/messages`, KOBE-30). */
  readonly idempotencyKey?: string | undefined;
  /** Lets the request outlive the page (a save on `pagehide`); small bodies only (64 KiB). */
  readonly keepalive?: boolean | undefined;
  /** Cancels the request (a search superseded by the next keystroke). */
  readonly signal?: AbortSignal | undefined;
  readonly fetchFn?: typeof fetch | undefined;
}

const MAX_MESSAGE = 300;

const FALLBACK: Readonly<Record<number, readonly [string, string]>> = {
  0: ["network_error", "Kobe is unreachable. Check your connection and try again."],
  400: ["invalid_request", "Check the request and try again."],
  401: ["unauthenticated", "Your session has ended. Sign in again."],
  403: ["forbidden", "You don't have permission to do that."],
  404: ["not_found", "Not found. It may have been removed."],
  409: ["conflict", "That conflicts with the current state. Reload and try again."],
  429: ["rate_limited", "Too many requests. Try again later."],
};

/** Codes whose server message is safe and useful to show even on a 5xx. */
const SHOWN_5XX_CODES: ReadonlySet<string> = new Set([
  "isolation_runtime_missing",
  // Run orchestrator (KOBE-30) and search (KOBE-33): fixed server messages written for people.
  "isolation_unavailable",
  "sandbox_unavailable",
  // KOBE-475: a file's saved copy is missing until the sandbox resends it (fixed message).
  "content_missing",
  "search_timeout",
  // KOBE-39: the site has no header-injection secret.
  "header_injection_unavailable",
  // Connector API keys (KOBE-108): the site has no envelope key to store them with.
  "credentials_unavailable",
  // Model admin (KOBE-40/44): fixed server messages naming the way out.
  "models_not_configured",
  "gateway_unavailable",
  // Workspace and team storage full (507, KOBE-148/143): a fixed message; KOBE-199 shows it.
  "quota_exceeded",
  // Compact now (KOBE-213): the contract's fixed message (502); never the sandbox's text.
  "compaction_failed",
  // Workbench scan preview (KOBE-321): the scan couldn't finish; the page retries.
  "scan_unavailable",
]);

function fallback(status: number): ApiError {
  const known = FALLBACK[status];
  if (known) return { status, code: known[0], message: known[1] };
  if (status >= 500) {
    return {
      status,
      code: "server_error",
      message: `Kobe had a problem (HTTP ${status}). Try again in a moment.`,
    };
  }
  return { status, code: "http_error", message: `The request failed (HTTP ${status}).` };
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function toError(status: number, body: unknown): ApiError {
  const base = fallback(status);
  if (body === null || typeof body !== "object") return base;
  const { code, message } = body as { code?: unknown; message?: unknown };
  const serverCode = typeof code === "string" && code.length <= 64 ? code : undefined;
  // 5xx bodies may carry internals: show them only for codes meant for people.
  if (status >= 500 && !(serverCode && SHOWN_5XX_CODES.has(serverCode))) return base;
  return {
    status,
    code: serverCode ?? base.code,
    message:
      typeof message === "string" && message.trim() !== ""
        ? message.slice(0, MAX_MESSAGE)
        : base.message,
  };
}

/** Only same-origin absolute paths: an API call must never leave this origin. */
function assertApiPath(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new Error(`API paths are same-origin absolute paths, got ${JSON.stringify(path)}.`);
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  assertApiPath(path);
  const {
    method = "GET",
    json,
    raw,
    form,
    teamId,
    ifMatch,
    idempotencyKey,
    keepalive,
    signal,
    fetchFn = fetch,
  } = options;
  const headers = new Headers({ accept: "application/json" });
  let body: string | Uint8Array<ArrayBuffer> | FormData | null = null;
  if (form !== undefined) {
    body = form;
  } else if (json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(json);
  } else if (raw !== undefined) {
    headers.set("content-type", raw.contentType);
    body = typeof raw.body === "string" ? raw.body : new Uint8Array(raw.body);
  }
  if (teamId !== undefined) headers.set(TEAM_HEADER, teamId);
  if (ifMatch !== undefined) headers.set("if-match", ifMatch);
  if (idempotencyKey !== undefined) headers.set("idempotency-key", idempotencyKey);

  let res: Response;
  try {
    res = await fetchFn(path, {
      method,
      headers,
      body,
      credentials: "same-origin",
      ...(keepalive ? { keepalive: true } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch {
    return { ok: false, error: fallback(0) };
  }
  const parsed = await readJson(res);
  if (!res.ok) return { ok: false, error: toError(res.status, parsed) };
  return { ok: true, status: res.status, data: camelizeKeys(parsed) as T };
}

/** A text file answer (e.g. an export), with the filename the server suggested. */
export interface TextFile {
  readonly text: string;
  readonly filename: string | null;
}

/** GET of a text file: like `apiRequest`, but the success body is returned as text, not JSON. */
export async function apiTextFile(
  path: string,
  options: Pick<RequestOptions, "teamId" | "fetchFn"> = {},
): Promise<ApiResult<TextFile>> {
  assertApiPath(path);
  const { teamId, fetchFn = fetch } = options;
  const headers = new Headers({ accept: "*/*" });
  if (teamId !== undefined) headers.set(TEAM_HEADER, teamId);
  let res: Response;
  try {
    res = await fetchFn(path, { method: "GET", headers, credentials: "same-origin" });
  } catch {
    return { ok: false, error: fallback(0) };
  }
  if (!res.ok) return { ok: false, error: toError(res.status, await readJson(res)) };
  const disposition = res.headers.get("content-disposition") ?? "";
  const filename = /filename="([^"\\/]{1,200})"/.exec(disposition)?.[1] ?? null;
  return { ok: true, status: res.status, data: { text: await res.text(), filename } };
}

/** At most `maxBytes` of a binary body, and whether there was more (`size`: Content-Length). */
export interface CappedBytes {
  readonly bytes: Uint8Array;
  readonly size: number | null;
  readonly truncated: boolean;
}

/** Reads the body until `maxBytes`, then cancels the rest (it is never downloaded in full). */
async function readUpTo(res: Response, maxBytes: number, wholeOnly: boolean): Promise<CappedBytes> {
  const length = Number(res.headers.get("content-length") ?? "NaN");
  const size = Number.isSafeInteger(length) ? length : null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (wholeOnly && size !== null && size > maxBytes) {
    await res.body?.cancel(); // only all of it would do: none of it is fetched
    return { bytes: new Uint8Array(0), size, truncated: true };
  }
  let truncated = false;
  const reader = res.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > maxBytes) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(total, maxBytes));
  let at = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - at);
    bytes.set(part, at);
    at += part.length;
  }
  return { bytes, size, truncated };
}

export type ErrorKind =
  "signIn" | "forbidden" | "notFound" | "chooseTeam" | "reload" | "isolation" | "other";

/** What the UI should offer for an error (sign in, pick a team, reload, isolation fix…). */
export function errorKind(error: ApiError): ErrorKind {
  if (error.status === 401) return "signIn";
  if (error.status === 403) return "forbidden";
  if (error.code === "isolation_runtime_missing" || error.code === "isolation_unavailable") {
    return "isolation";
  }
  if (error.code === "no_active_team") return "chooseTeam";
  if (error.code === "team_mismatch") return "reload";
  if (error.status === 404) return "notFound";
  return "other";
}

/** A GET whose body is binary: the response when it is ok, else the same `ApiError`s as `apiRequest`. */
async function getBinary(
  path: string,
  options: Pick<RequestOptions, "teamId" | "fetchFn">,
): Promise<
  { readonly ok: true; readonly res: Response } | { readonly ok: false; readonly error: ApiError }
> {
  assertApiPath(path);
  const { teamId, fetchFn = fetch } = options;
  const headers = new Headers();
  if (teamId !== undefined) headers.set(TEAM_HEADER, teamId);
  let res: Response;
  try {
    res = await fetchFn(path, { method: "GET", headers, credentials: "same-origin" });
  } catch {
    return { ok: false, error: fallback(0) };
  }
  if (!res.ok) return { ok: false, error: toError(res.status, await readJson(res)) };
  return { ok: true, res };
}

/** GET of a binary body (a skill bundle); errors are the same `ApiError`s as `apiRequest`. */
export async function apiDownload(
  path: string,
  options: Pick<RequestOptions, "teamId" | "fetchFn"> = {},
): Promise<ApiResult<Uint8Array>> {
  const got = await getBinary(path, options);
  if (!got.ok) return got;
  try {
    return { ok: true, status: got.res.status, data: new Uint8Array(await got.res.arrayBuffer()) };
  } catch {
    return { ok: false, error: fallback(0) };
  }
}

/**
 * GET of a binary body capped at `maxBytes` (a preview): the rest is never fetched. `wholeOnly`
 * (an image, or `maxBytes` 0 for headers only): a body whose Content-Length is over the cap is
 * not read at all.
 */
export async function apiReadCapped(
  path: string,
  maxBytes: number,
  options: Pick<RequestOptions, "teamId" | "fetchFn"> & { readonly wholeOnly?: boolean } = {},
): Promise<ApiResult<CappedBytes>> {
  const got = await getBinary(path, options);
  if (!got.ok) return got;
  try {
    const data = await readUpTo(got.res, maxBytes, options.wholeOnly === true);
    return { ok: true, status: got.res.status, data };
  } catch {
    return { ok: false, error: fallback(0) };
  }
}
