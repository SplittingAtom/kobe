import { Readable } from "node:stream";
import {
  WORKSPACE_ENTRY_HEADER,
  WORKSPACE_SYNC_PATH,
  decodeWorkspaceEntryHeader,
  workspaceBlobsMissingResponseSchema,
  workspaceCommitResponseSchema,
  workspaceManifestPageSchema,
  type WorkspaceChange,
  type WorkspaceEntry,
  type WorkspaceRestoreReport,
} from "@kobe/protocol";
import type { z } from "zod";

/**
 * HTTP client for the server's workspace sync endpoints (contract: packages/protocol
 * sandbox-wire/workspace-sync.ts), on the same sandbox listener the wire dials. Auth: the
 * `kobe.sandbox-wire` token. The sandbox never talks to object storage and holds no storage
 * credentials or keys. Node's `fetch` does not use HTTP(S)_PROXY, so the server is reached
 * directly (as for the session exchange).
 */
export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SyncHttpError";
  }
}

export interface SyncClientOptions {
  /** KOBE_SERVER_URL (ws:// or wss://). */
  readonly serverUrl: string;
  readonly readToken: () => Promise<string>;
  /** JSON calls: the whole exchange. Transfers: until the response starts. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

const MAX_JSON_RESPONSE = 8 * 1024 * 1024;

export function syncBaseUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = WORKSPACE_SYNC_PATH;
  url.search = "";
  return url.toString();
}

export class SyncClient {
  readonly #base: string;
  readonly #options: SyncClientOptions;
  readonly #fetch: typeof fetch;

  constructor(options: SyncClientOptions) {
    this.#options = options;
    this.#base = syncBaseUrl(options.serverUrl);
    this.#fetch = options.fetch ?? fetch;
  }

  manifest(since: number, limit = 1000) {
    return this.#json(
      workspaceManifestPageSchema,
      "GET",
      `/manifest?since=${since}&limit=${limit}`,
    );
  }

  async missing(sha256: readonly string[]): Promise<string[]> {
    const out = await this.#json(workspaceBlobsMissingResponseSchema, "POST", "/blobs/missing", {
      sha256,
    });
    return out.missing;
  }

  /** Streams a blob (exact Content-Length); 200/201 → stored. */
  async upload(sha256: string, body: Readable, size: number): Promise<void> {
    const res = await this.#send("PUT", `/blobs/${sha256}`, {
      body: Readable.toWeb(body) as ReadableStream,
      headers: { "content-type": "application/octet-stream", "content-length": String(size) },
      // The server answers once the bytes are stored: allow for them at ≥ 1 MiB/s.
      timeoutMs: (this.#options.timeoutMs ?? 30_000) + Math.ceil(size / 1024),
    });
    await this.#check(res);
    await res.body?.cancel();
  }

  commit(changes: readonly WorkspaceChange[]) {
    return this.#json(workspaceCommitResponseSchema, "POST", "/commit", { changes });
  }

  /** The current content of a live path, or undefined when it is gone. */
  async download(path: string): Promise<{ entry: WorkspaceEntry; body: Readable } | undefined> {
    const res = await this.#send("GET", `/file?path=${encodeURIComponent(path)}`, {
      transfer: true,
    });
    if (res.status === 404) {
      await res.body?.cancel();
      return undefined;
    }
    await this.#check(res);
    const entry = decodeWorkspaceEntryHeader(res.headers.get(WORKSPACE_ENTRY_HEADER));
    if (!entry || entry.path !== path || entry.sha256 === undefined || !res.body) {
      await res.body?.cancel();
      throw new SyncHttpError(502, "bad_response", "file response without a valid entry");
    }
    return { entry, body: Readable.fromWeb(res.body as never) };
  }

  async restoreReport(report: WorkspaceRestoreReport): Promise<void> {
    const res = await this.#send("POST", "/restore-report", { json: report });
    await this.#check(res);
    await res.body?.cancel();
  }

  async #json<S extends z.ZodType>(
    schema: S,
    method: string,
    path: string,
    json?: unknown,
  ): Promise<z.infer<S>> {
    const res = await this.#send(method, path, json === undefined ? {} : { json });
    await this.#check(res);
    const text = await readText(res, MAX_JSON_RESPONSE);
    const parsed = schema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new SyncHttpError(502, "bad_response", `invalid ${path} response`);
    return parsed.data;
  }

  async #check(res: Response): Promise<void> {
    if (res.ok) return;
    let code = "http_error";
    let message = `HTTP ${res.status}`;
    try {
      const body = JSON.parse(await readText(res, 64 * 1024)) as {
        code?: unknown;
        message?: unknown;
      };
      if (typeof body.code === "string") code = body.code;
      if (typeof body.message === "string") message = body.message;
    } catch {
      // not JSON
    }
    const retry = Number(res.headers.get("retry-after"));
    throw new SyncHttpError(
      res.status,
      code,
      message,
      Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined,
    );
  }

  async #send(
    method: string,
    path: string,
    options: {
      readonly json?: unknown;
      readonly body?: ReadableStream;
      readonly headers?: Record<string, string>;
      /** A transfer: the timeout covers only the wait for the response to start. */
      readonly transfer?: boolean;
      readonly timeoutMs?: number;
    },
  ): Promise<Response> {
    const token = await this.#options.readToken();
    const abort = new AbortController();
    const timer = setTimeout(
      () => abort.abort(new SyncHttpError(0, "timeout", "request timed out")),
      options.timeoutMs ?? this.#options.timeoutMs ?? 30_000,
    );
    timer.unref();
    try {
      const res = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(options.json === undefined ? {} : { "content-type": "application/json" }),
          ...options.headers,
        },
        ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
        ...(options.body === undefined ? {} : { body: options.body, duplex: "half" }),
        signal: abort.signal,
        redirect: "error",
      } as RequestInit);
      if (options.transfer) clearTimeout(timer);
      return res;
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
  }
}

async function readText(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > max) {
      await res.body.cancel().catch(() => {});
      throw new SyncHttpError(502, "bad_response", "response too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
