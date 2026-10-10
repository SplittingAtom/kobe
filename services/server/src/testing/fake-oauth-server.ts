import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// A fake MCP server + authorization server (tests only), modelled on the MCP 2026-07-28
// authorization spec: protected resource metadata, AS metadata, DCR, PKCE S256 checked at the
// token endpoint, RFC 8707 resource, RFC 9207 iss. It records what it was sent.

export interface FakeOauthOptions {
  /** AS metadata advertises PKCE S256 (default true). */
  readonly pkce?: boolean;
  /** `authorization_response_iss_parameter_supported` (default true). */
  readonly issSupported?: boolean;
  /** What /authorize puts in `iss` (default: the real issuer). */
  readonly issuerInRedirect?: string | null;
  /** Advertise CIMD support. */
  readonly cimd?: boolean;
  /** `resource` in the protected resource metadata (default: the MCP URL). */
  readonly prmResource?: string;
  /** Advertised issuer (default: the base URL). */
  readonly metadataIssuer?: string;
  /** Registration endpoint advertised (default true). */
  readonly dcr?: boolean;
  readonly expiresIn?: number;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

export class FakeOauthServer {
  private server!: Server;
  base = "";
  readonly registrations: Record<string, unknown>[] = [];
  readonly tokenRequests: URLSearchParams[] = [];
  readonly authorizeRequests: URLSearchParams[] = [];
  readonly tokenAuthHeaders: (string | undefined)[] = [];
  readonly issued: IssuedTokens[] = [];
  private readonly codes = new Map<
    string,
    { challenge: string; clientId: string; used: boolean }
  >();
  private readonly clients = new Map<string, string | undefined>();
  private n = 0;

  constructor(public options: FakeOauthOptions = {}) {}

  get mcpUrl(): string {
    return `${this.base}/mcp`;
  }
  get port(): number {
    return Number(new URL(this.base).port);
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }

  /** Plays the browser at /authorize: returns the redirect Kobe's callback should receive. */
  async authorize(authorizationUrl: string): Promise<URL> {
    const res = await fetch(authorizationUrl, { redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status !== 302 || !location) throw new Error(`authorize answered ${res.status}`);
    return new URL(location);
  }

  private json(res: ServerResponse, body: unknown, status = 200) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", this.base);
    const o = this.options;
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return this.json(res, {
        resource: o.prmResource ?? this.mcpUrl,
        authorization_servers: [this.base],
        scopes_supported: ["tools"],
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return this.json(res, {
        issuer: o.metadataIssuer ?? this.base,
        authorization_endpoint: `${this.base}/authorize`,
        token_endpoint: `${this.base}/token`,
        ...(o.dcr === false ? {} : { registration_endpoint: `${this.base}/register` }),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
        ...(o.pkce === false ? {} : { code_challenge_methods_supported: ["S256"] }),
        authorization_response_iss_parameter_supported: o.issSupported ?? true,
        client_id_metadata_document_supported: o.cimd ?? false,
      });
    }
    if (url.pathname === "/register" && req.method === "POST") {
      const reg = JSON.parse(await this.body(req)) as Record<string, unknown>;
      this.registrations.push(reg);
      const clientId = `client-${randomUUID()}`;
      const secret =
        reg.token_endpoint_auth_method === "none" ? undefined : randomBytes(16).toString("hex");
      this.clients.set(clientId, secret);
      return this.json(
        res,
        { client_id: clientId, ...(secret ? { client_secret: secret } : {}) },
        201,
      );
    }
    if (url.pathname === "/authorize") {
      this.authorizeRequests.push(url.searchParams);
      const p = url.searchParams;
      const redirect = p.get("redirect_uri");
      if (!redirect || !p.get("code_challenge") || p.get("code_challenge_method") !== "S256") {
        return this.json(res, { error: "invalid_request" }, 400);
      }
      const code = `code-${randomUUID()}`;
      this.codes.set(code, {
        challenge: p.get("code_challenge") ?? "",
        clientId: p.get("client_id") ?? "",
        used: false,
      });
      const back = new URL(redirect);
      back.searchParams.set("code", code);
      back.searchParams.set("state", p.get("state") ?? "");
      const iss = o.issuerInRedirect === undefined ? this.base : o.issuerInRedirect;
      if (iss !== null) back.searchParams.set("iss", iss);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await this.body(req));
      this.tokenRequests.push(form);
      this.tokenAuthHeaders.push(req.headers.authorization);
      const entry = this.codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const clientId = form.get("client_id") ?? basicClient(req.headers.authorization);
      const secret = this.clients.get(clientId ?? "");
      const basicOk =
        secret === undefined || req.headers.authorization === basic(clientId ?? "", secret);
      if (
        !entry ||
        entry.used ||
        entry.challenge !== challenge ||
        form.get("grant_type") !== "authorization_code" ||
        form.get("resource") !== this.mcpUrl ||
        !basicOk
      ) {
        if (entry) entry.used = true;
        return this.json(res, { error: "invalid_grant" }, 400);
      }
      entry.used = true;
      const n = ++this.n;
      const tokens = {
        accessToken: `at-secret-${n}-${randomBytes(8).toString("hex")}`,
        refreshToken: `rt-secret-${n}-${randomBytes(8).toString("hex")}`,
      };
      this.issued.push(tokens);
      return this.json(res, {
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: o.expiresIn ?? 3600,
        refresh_token: tokens.refreshToken,
        scope: "tools",
      });
    }
    this.json(res, { error: "not_found" }, 404);
  }
}

const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;
const basicClient = (header: string | undefined): string | undefined => {
  if (!header?.startsWith("Basic ")) return undefined;
  const [id] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
  return id ? decodeURIComponent(id) : undefined;
};
