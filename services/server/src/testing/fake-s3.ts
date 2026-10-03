import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny S3-compatible HTTP server for tests (path-style PutObject with or without a copy source,
 * GetObject, DeleteObject), in memory. Not a dependency, not shipped: just enough to exercise
 * `s3.ts` against real HTTP and the AWS SDK. It insists on SigV4 with the expected access key and
 * on a complete body (an upload cut short stores nothing, like S3).
 */
export class FakeS3 {
  readonly objects = new Map<string, Buffer>();
  readonly requests: { method: string; key: string }[] = [];
  #server: Server | undefined;

  constructor(
    readonly bucket: string,
    readonly accessKeyId: string,
  ) {}

  async start(): Promise<string> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
    const { port } = this.#server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    this.#server?.closeAllConnections();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://s3.test");
    const [, bucket, ...rest] = url.pathname.split("/");
    const key = rest.map(decodeURIComponent).join("/");
    const method = req.method ?? "GET";
    this.requests.push({ method, key });
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith(`AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/`)) {
      return this.#error(res, 403, "AccessDenied");
    }
    if (bucket !== this.bucket) return this.#error(res, 404, "NoSuchBucket");
    if (method === "PUT") {
      const source = req.headers["x-amz-copy-source"];
      if (typeof source === "string") {
        const from = decodeURIComponent(source.replace(/^\/?[^/]+\//, ""));
        const data = this.objects.get(from);
        if (!data) return this.#error(res, 404, "NoSuchKey");
        this.objects.set(key, Buffer.from(data));
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"x"</ETag><LastModified>2026-01-01T00:00:00.000Z</LastModified></CopyObjectResult>`,
        );
        return;
      }
      const body = await readBody(req);
      if (body === undefined) return; // aborted: nothing stored
      this.objects.set(key, body);
      res.writeHead(200, { etag: '"x"' });
      res.end();
      return;
    }
    if (method === "GET" || method === "HEAD") {
      const data = this.objects.get(key);
      if (!data) return this.#error(res, 404, "NoSuchKey");
      res.writeHead(200, {
        "content-length": String(data.length),
        "content-type": "application/octet-stream",
        etag: '"x"',
      });
      res.end(method === "GET" ? data : undefined);
      return;
    }
    if (method === "DELETE") {
      this.objects.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }
    this.#error(res, 405, "MethodNotAllowed");
  }

  #error(res: ServerResponse, status: number, code: string): void {
    res.writeHead(status, { "content-type": "application/xml" });
    res.end(
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
    );
  }
}

/** The whole body, decoding aws-chunked framing; undefined when the upload was cut short. */
async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const declared = Number(req.headers["content-length"] ?? "NaN");
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of req) chunks.push(chunk as Buffer);
  } catch {
    return undefined;
  }
  const raw = Buffer.concat(chunks);
  if (req.readableAborted || (Number.isFinite(declared) && raw.length !== declared)) {
    return undefined;
  }
  const sha = String(req.headers["x-amz-content-sha256"] ?? "");
  const encoding = String(req.headers["content-encoding"] ?? "");
  if (!sha.startsWith("STREAMING-") && !encoding.includes("aws-chunked")) return raw;
  const out: Buffer[] = [];
  let at = 0;
  for (;;) {
    const eol = raw.indexOf("\r\n", at);
    if (eol < 0) return undefined;
    const size = parseInt(raw.subarray(at, eol).toString().split(";")[0] ?? "", 16);
    if (!Number.isFinite(size)) return undefined;
    if (size === 0) break;
    out.push(raw.subarray(eol + 2, eol + 2 + size));
    at = eol + 2 + size + 2;
  }
  return Buffer.concat(out);
}
