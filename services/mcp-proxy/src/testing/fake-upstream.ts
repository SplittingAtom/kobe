import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake remote MCP server (Streamable HTTP) for tests: records every JSON-RPC message it gets and
 * answers `initialize`, `tools/list` and `tools/call` (echoing the arguments). Behaviour switches
 * let tests make it misbehave.
 */
export interface FakeUpstreamOptions {
  /** Answer requests as an SSE stream instead of JSON. */
  sse?: boolean;
  /** Issue an `Mcp-Session-Id` on initialize (and require it afterwards). */
  session?: boolean;
  protocolVersion?: string;
  /** HTTP status for every POST (e.g. 401). */
  status?: number;
  /** Delay before answering tools/call. */
  delayMs?: number;
  /** Bytes of padding in the tools/call result. */
  padding?: number;
  /** Answer tools/call with a JSON-RPC error. */
  rpcError?: boolean;
  /** The tools `tools/list` returns (default: none). */
  tools?: Record<string, unknown>[];
  /** Page size for `tools/list` (cursor = start index as text); default: all in one page. */
  pageSize?: number;
  /** Redirect every POST elsewhere. */
  redirectTo?: string;
  /**
   * The resources `resources/list` returns and `resources/read` serves (KOBE-433); unset: both
   * answer "method not found", like a server without resources.
   */
  resources?: FakeResource[];
  /** Answer `resources/read` with a JSON-RPC error. */
  readError?: boolean;
  /** Answer `resources/list` with this JSON-RPC error code. */
  listErrorCode?: number;
  /** Always hand out another `resources/list` page. */
  endlessResources?: boolean;
  /** The `uri` the read's content item claims (default: the one asked for). */
  readUri?: string;
}

export interface FakeResource {
  readonly uri: string;
  readonly mimeType?: string;
  /** On the `resources/list` entry. */
  readonly _meta?: Record<string, unknown>;
  readonly text?: string;
  readonly blob?: string;
  /** On the `resources/read` content item. */
  readonly contentMeta?: Record<string, unknown>;
  /** Left out of `resources/list` (still readable). */
  readonly unlisted?: boolean;
}

export interface Received {
  readonly method: string;
  readonly message: Record<string, unknown>;
  readonly headers: IncomingMessage["headers"];
}

export class FakeUpstream {
  readonly received: Received[] = [];
  readonly deletes: string[] = [];
  options: FakeUpstreamOptions = {};
  private server?: Server;

  get url(): string {
    const { port } = this.server?.address() as AddressInfo;
    return `http://127.0.0.1:${port}/mcp`;
  }

  calls(): Received[] {
    return this.received.filter((r) => r.method === "tools/call");
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    return this;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "DELETE") {
      this.deletes.push(String(req.headers["mcp-session-id"]));
      res.writeHead(200).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const method = String(message.method ?? "response");
    this.received.push({ method, message, headers: req.headers });
    const o = this.options;
    if (o.redirectTo) {
      res.writeHead(307, { location: o.redirectTo }).end();
      return;
    }
    if (o.status) {
      res.writeHead(o.status).end();
      return;
    }
    if (o.session && method !== "initialize" && req.headers["mcp-session-id"] !== "sess-1") {
      res.writeHead(404).end();
      return;
    }
    if (!("id" in message)) {
      res.writeHead(202).end();
      return;
    }
    const id = message.id;
    let reply: Record<string, unknown>;
    if (method === "initialize") {
      reply = {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: o.protocolVersion ?? "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "0" },
        },
      };
    } else if (method === "tools/call") {
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      const params = message.params as { name: string; arguments: unknown };
      reply = o.rpcError
        ? { jsonrpc: "2.0", id, error: { code: -32010, message: "upstream says no" } }
        : {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: `${params.name}:${JSON.stringify(params.arguments)}${"x".repeat(o.padding ?? 0)}`,
                },
              ],
            },
          };
    } else if (method === "tools/list") {
      const all = o.tools ?? [];
      const params = (message.params ?? {}) as { cursor?: string };
      const start = params.cursor === undefined ? 0 : Number(params.cursor);
      const size = o.pageSize ?? all.length;
      const end = start + size;
      reply = {
        jsonrpc: "2.0",
        id,
        result: {
          tools: all.slice(start, end),
          ...(end < all.length ? { nextCursor: String(end) } : {}),
        },
      };
    } else if (method === "resources/list" && o.resources && o.listErrorCode !== undefined) {
      reply = { jsonrpc: "2.0", id, error: { code: o.listErrorCode, message: "no list" } };
    } else if (method === "resources/list" && o.resources) {
      reply = {
        jsonrpc: "2.0",
        id,
        result: {
          resources: o.resources
            .filter((r) => !r.unlisted)
            .map((r) => ({
              uri: r.uri,
              name: r.uri,
              ...(r.mimeType === undefined ? {} : { mimeType: r.mimeType }),
              ...(r._meta === undefined ? {} : { _meta: r._meta }),
            })),
          ...(o.endlessResources ? { nextCursor: "more" } : {}),
        },
      };
    } else if (method === "resources/read" && o.resources) {
      const uri = (message.params as { uri?: string }).uri;
      const found = o.resources.find((r) => r.uri === uri);
      reply =
        o.readError || !found
          ? { jsonrpc: "2.0", id, error: { code: -32002, message: "not found" } }
          : {
              jsonrpc: "2.0",
              id,
              result: {
                contents: [
                  {
                    uri: o.readUri ?? found.uri,
                    ...(found.mimeType === undefined ? {} : { mimeType: found.mimeType }),
                    ...(found.text === undefined ? {} : { text: found.text }),
                    ...(found.blob === undefined ? {} : { blob: found.blob }),
                    ...(found.contentMeta === undefined ? {} : { _meta: found.contentMeta }),
                  },
                ],
              },
            };
    } else {
      reply = { jsonrpc: "2.0", id, error: { code: -32601, message: "nope" } };
    }
    const headers: Record<string, string> = {};
    if (o.session && method === "initialize") headers["mcp-session-id"] = "sess-1";
    if (o.sse) {
      res.writeHead(200, { ...headers, "content-type": "text/event-stream" });
      // A server notification first (ignored by the client), then the response.
      res.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`,
      );
      res.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  }
}
