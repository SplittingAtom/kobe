import type { Hono } from "hono";

let nextIp = 1;

export interface TestResponse {
  readonly status: number;
  readonly json: any;
  readonly headers: Headers;
  readonly text: string;
}

/** A request body sent as-is with its own content type (e.g. a markdown file upload). */
export class RawBody {
  constructor(
    readonly content: string | Uint8Array,
    readonly contentType: string,
  ) {}
}

/**
 * Minimal browser for integration tests: keeps cookies, sends the Origin header the CSRF checks
 * expect, and uses its own client IP (rate limits are per IP, via X-Forwarded-For).
 */
export class TestBrowser {
  readonly cookies = new Map<string, string>();
  readonly ip = `198.51.100.${nextIp++ % 250}`;
  /** When set, sent as X-Kobe-Team (the team this "tab" believes is active). */
  team: string | undefined;

  constructor(
    private readonly app: Hono,
    private readonly publicUrl: string,
  ) {}

  async request(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<TestResponse> {
    const headers: Record<string, string> = {
      origin: this.publicUrl,
      "x-forwarded-for": this.ip,
      ...(this.team ? { "x-kobe-team": this.team } : {}),
      ...extraHeaders,
    };
    if (this.cookies.size > 0)
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const raw = body instanceof RawBody;
    if (body !== undefined) headers["content-type"] = raw ? body.contentType : "application/json";
    const res = await this.app.request(`${this.publicUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: raw ? body.content : JSON.stringify(body) } : {}),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [name, ...rest] = (pair ?? "").split("=");
      const value = rest.join("=");
      if (!name) continue;
      if (value === "" || /max-age=0/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    return { status: res.status, json, headers: res.headers, text };
  }

  get = (path: string, headers?: Record<string, string>) =>
    this.request("GET", path, undefined, headers);
  post = (path: string, body: unknown = {}) => this.request("POST", path, body);
  put = (path: string, body: unknown = {}, headers?: Record<string, string>) =>
    this.request("PUT", path, body, headers);
  patch = (path: string, body: unknown = {}) => this.request("PATCH", path, body);
  delete = (path: string) => this.request("DELETE", path);
}
