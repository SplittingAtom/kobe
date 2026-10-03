import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  WORKSPACE_ENTRY_HEADER,
  WORKSPACE_SYNC_PATH,
  encodeWorkspaceEntryHeader,
  isExcludedPath,
  isServerOwnedPath,
  workspaceCommitRequestSchema,
  type WorkspaceChangeResult,
  type WorkspaceEntry,
  type WorkspaceRestoreReport,
} from "@kobe/protocol";

/**
 * An in-memory stand-in for the server's workspace sync endpoints (contract:
 * packages/protocol sandbox-wire/workspace-sync.ts), over real HTTP so the agent's client is
 * exercised too. Same rules as the server: per-path compare-and-set, server-owned areas refused,
 * hash-verified uploads. The real endpoints are tested in services/server.
 */
export class FakeSyncServer {
  readonly token = "sync-token";
  readonly blobs = new Map<string, Buffer>();
  readonly rows = new Map<string, WorkspaceEntry>();
  readonly reports: WorkspaceRestoreReport[] = [];
  readonly requests: string[] = [];
  head = 0;
  /** Tombstones at or below this revision were purged (compaction). */
  horizon = 0;
  /** Answer every request with this status (e.g. 404: sync not configured). */
  failWith: number | undefined;
  #server: Server | undefined;

  async start(): Promise<string> {
    this.#server = createServer((req, res) => {
      this.#handle(req, res).catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((r) => this.#server?.listen(0, "127.0.0.1", r));
    const { port } = this.#server.address() as AddressInfo;
    return `ws://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    this.#server?.closeAllConnections();
    await new Promise<void>((r) => this.#server?.close(() => r()));
  }

  /** A server-side write (upload, project file, file browser). */
  serverWrite(path: string, content: string | Buffer, executable = false): WorkspaceEntry {
    const data = Buffer.from(content);
    const sha256 = createHash("sha256").update(data).digest("hex");
    this.blobs.set(sha256, data);
    return this.#write(
      path,
      { sha256, size: data.length, mtime_ms: Date.now(), executable },
      "server",
    );
  }

  serverDelete(path: string): void {
    const row = this.rows.get(path);
    if (row && !row.deleted) this.#delete(path, row, "server");
  }

  /** Purges every tombstone and moves the horizon to the head (the server's compaction). */
  compact(): void {
    for (const [path, row] of this.rows) if (row.deleted) this.rows.delete(path);
    this.horizon = this.head;
  }

  content(path: string): string | undefined {
    const row = this.rows.get(path);
    return row && !row.deleted && row.sha256 ? this.blobs.get(row.sha256)?.toString() : undefined;
  }

  livePaths(): string[] {
    return [...this.rows.values()]
      .filter((r) => !r.deleted)
      .map((r) => r.path)
      .sort();
  }

  #write(
    path: string,
    f: { sha256: string; size: number; mtime_ms: number; executable: boolean },
    origin: "sandbox" | "server",
  ): WorkspaceEntry {
    this.head += 1;
    const entry: WorkspaceEntry = {
      path,
      rev: this.head,
      deleted: false,
      ...f,
      origin,
      updated_ms: Date.now(),
    };
    this.rows.set(path, entry);
    return entry;
  }

  #delete(path: string, row: WorkspaceEntry, origin: "sandbox" | "server"): WorkspaceEntry {
    this.head += 1;
    const { sha256: _s, ...rest } = row;
    const entry: WorkspaceEntry = {
      ...rest,
      rev: this.head,
      deleted: true,
      origin,
      updated_ms: Date.now(),
    };
    this.rows.set(path, entry);
    return entry;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const route = url.pathname.slice(WORKSPACE_SYNC_PATH.length);
    this.requests.push(`${req.method} ${route}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (this.failWith !== undefined) return json(this.failWith, { code: "nope", message: "nope" });
    if (!url.pathname.startsWith(WORKSPACE_SYNC_PATH))
      return json(404, { code: "x", message: "x" });
    if (req.headers.authorization !== `Bearer ${this.token}`)
      return json(401, { code: "unauthorized", message: "" });
    const body = await read(req);
    if (req.method === "GET" && route === "/manifest") {
      const since = Number(url.searchParams.get("since") ?? 0);
      if (since > 0 && since < this.horizon) {
        return json(409, { code: "resync_required", message: "" });
      }
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      const all = [...this.rows.values()]
        .filter((r) => r.rev > since)
        .sort((a, b) => a.rev - b.rev);
      return json(200, {
        head_rev: this.head,
        entries: all.slice(0, limit),
        more: all.length > limit,
      });
    }
    if (req.method === "POST" && route === "/blobs/missing") {
      const { sha256 } = JSON.parse(body.toString()) as { sha256: string[] };
      return json(200, { missing: [...new Set(sha256)].filter((h) => !this.blobs.has(h)) });
    }
    const blob = /^\/blobs\/([0-9a-f]{64})$/.exec(route);
    if (req.method === "PUT" && blob?.[1]) {
      const hash = createHash("sha256").update(body).digest("hex");
      if (hash !== blob[1]) return json(422, { code: "hash_mismatch", message: "" });
      this.blobs.set(hash, body);
      return json(201, { sha256: hash, size: body.length });
    }
    if (req.method === "POST" && route === "/commit") {
      const { changes } = workspaceCommitRequestSchema.parse(JSON.parse(body.toString()));
      const results: WorkspaceChangeResult[] = changes.map((c) => {
        if (isServerOwnedPath(c.path) || isExcludedPath(c.path)) {
          return { status: "rejected", path: c.path, code: "read_only" };
        }
        const cur = this.rows.get(c.path);
        const live = cur !== undefined && !cur.deleted;
        if (c.op === "delete") {
          if (!live) return { status: "noop", path: c.path };
          if (c.base_rev !== cur.rev) return { status: "conflict", path: c.path, current: cur };
          return { status: "applied", path: c.path, entry: this.#delete(c.path, cur, "sandbox") };
        }
        if (live && c.base_rev !== cur.rev)
          return { status: "conflict", path: c.path, current: cur };
        if (!this.blobs.has(c.sha256))
          return { status: "rejected", path: c.path, code: "missing_blob" };
        const { op: _op, base_rev: _b, path, ...f } = c;
        return { status: "applied", path, entry: this.#write(path, f, "sandbox") };
      });
      return json(200, { head_rev: this.head, results });
    }
    if (req.method === "GET" && route === "/file") {
      const row = this.rows.get(url.searchParams.get("path") ?? "");
      if (!row || row.deleted || !row.sha256) return json(404, { code: "not_found", message: "" });
      const data = this.blobs.get(row.sha256) ?? Buffer.alloc(0);
      res.writeHead(200, {
        "content-length": String(data.length),
        [WORKSPACE_ENTRY_HEADER]: encodeWorkspaceEntryHeader(row),
      });
      res.end(data);
      return;
    }
    if (req.method === "POST" && route === "/restore-report") {
      this.reports.push(JSON.parse(body.toString()) as WorkspaceRestoreReport);
      res.writeHead(204);
      res.end();
      return;
    }
    json(404, { code: "not_found", message: "" });
  }
}

async function read(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
