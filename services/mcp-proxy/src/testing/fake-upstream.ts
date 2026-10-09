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
