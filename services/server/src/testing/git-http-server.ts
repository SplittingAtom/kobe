import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
  connect as netConnect,
  createServer as createNetServer,
  type AddressInfo,
  type Server,
} from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A local smart-HTTP git server for tests (KOBE-343): `git http-backend` behind a Node server,
 * over bare repositories in a temp directory, with Basic auth, non-fast-forward pushes refused
 * (as GitHub and Forgejo do on protected branches). No network beyond 127.0.0.1.
 */
export interface GitServer {
  readonly root: string;
  readonly origin: string;
  readonly requests: { method: string; url: string; authorization: string | undefined }[];
  /** Creates a bare repository `<name>.git` and returns its URL. */
  repo(name: string): string;
  /** Runs git in a fresh clone of `name` (or inside the bare repository with `bare`). */
  git(name: string, args: readonly string[], opts?: { bare?: boolean }): string;
  close(): Promise<void>;
}

export interface GitServerOptions {
  readonly credentials?: { readonly username: string; readonly token: string };
  readonly tls?: { readonly key: string; readonly cert: string };
}

function cgi(root: string, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const url = new URL(req.url ?? "/", "http://x");
  const child = spawn("git", ["http-backend"], {
    env: {
      PATH: process.env.PATH ?? "",
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      REMOTE_USER: "test",
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method ?? "GET",
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      CONTENT_LENGTH: String(body.length),
      GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
    },
  });
  const out: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => out.push(c));
  child.stdin.end(body);
  child.on("close", () => {
    const all = Buffer.concat(out);
    let split = all.indexOf("\r\n\r\n");
    let sep = 4;
    if (split < 0) {
      split = all.indexOf("\n\n");
      sep = 2;
    }
    const head = all.subarray(0, split).toString("latin1");
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of head.split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k.toLowerCase() === "status") status = Number(v.split(" ")[0]);
      else headers[k] = v;
    }
    res.writeHead(status, headers);
    res.end(all.subarray(split + sep));
  });
}

export async function startGitServer(options: GitServerOptions = {}): Promise<GitServer> {
  const root = mkdtempSync(path.join(tmpdir(), "kobe-git-server-"));
  const requests: GitServer["requests"] = [];
  const expected = options.credentials
    ? `Basic ${Buffer.from(`${options.credentials.username}:${options.credentials.token}`).toString("base64")}`
    : undefined;
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      authorization: req.headers.authorization,
    });
    if (expected && req.headers.authorization !== expected) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => cgi(root, req, res, Buffer.concat(chunks)));
  };
  const server = options.tls
    ? createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, handler)
    : createHttpServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const origin = `${options.tls ? "https" : "http"}://localhost:${port}`;
  const run = (cwd: string, args: readonly string[]) =>
    execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Someone Else",
        GIT_AUTHOR_EMAIL: "else@example.org",
        GIT_COMMITTER_NAME: "Someone Else",
        GIT_COMMITTER_EMAIL: "else@example.org",
      },
    });
  return {
    root,
    origin,
    requests,
    repo(name) {
      const dir = path.join(root, `${name}.git`);
      run(root, ["init", "--quiet", "--bare", "-b", "main", dir]);
      run(dir, ["config", "http.receivepack", "true"]);
      run(dir, ["config", "receive.denyNonFastForwards", "true"]);
      run(dir, ["config", "receive.denyDeletes", "true"]);
      return `${origin}/${name}.git`;
    },
    git(name, args, opts = {}) {
      const bare = path.join(root, `${name}.git`);
      if (opts.bare) return run(bare, args);
      const work = mkdtempSync(path.join(root, "work-"));
      run(root, ["clone", "--quiet", bare, work]);
      return run(work, args);
    },
    async close() {
      server.closeAllConnections();
      server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A minimal CONNECT proxy for tests: checks the bearer token, tunnels to 127.0.0.1:<port>. */
export async function startConnectProxy(opts: {
  readonly accept: (authorization: string | undefined, target: string) => boolean;
  readonly upstreamPort: number;
}): Promise<{ url: string; connects: string[]; close(): void }> {
  const connects: string[] = [];
  const server: Server = createNetServer((client) => {
    let buf = Buffer.alloc(0);
    const onData = (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.off("data", onData);
      const head = buf.subarray(0, end).toString("latin1").split("\r\n");
      const [method, target] = (head[0] ?? "").split(" ");
      const auth = head
        .find((l) => l.toLowerCase().startsWith("proxy-authorization:"))
        ?.slice("proxy-authorization:".length)
        .trim();
      connects.push(target ?? "");
      if (method !== "CONNECT" || !opts.accept(auth, target ?? "")) {
        client.end("HTTP/1.1 403 Kobe egress blocked: test\r\n\r\n");
        return;
      }
      const upstream = netConnect(opts.upstreamPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const rest = buf.subarray(end + 4);
        if (rest.length > 0) upstream.write(rest);
        client.pipe(upstream).pipe(client);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    };
    client.on("data", onData);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    connects,
    close: () => server.close(),
  };
}

/** A throwaway self-signed certificate for `name` (SAN), made with the openssl CLI. */
export function selfSignedCert(name: string): { key: string; cert: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "kobe-git-cert-"));
  try {
    const key = path.join(dir, "key.pem");
    const cert = path.join(dir, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        `/CN=${name}`,
        "-addext",
        `subjectAltName=DNS:${name}`,
      ],
      { stdio: "ignore" },
    );
    return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
