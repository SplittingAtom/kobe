import type { Hono } from "hono";

let nextIp = 1;

export interface TestResponse {
  readonly status: number;
  readonly json: any;
}

/**
 * Minimal browser for integration tests: keeps cookies, sends the Origin header the CSRF checks
 * expect, and uses its own client IP (rate limits are per IP, via X-Forwarded-For).
 */
export class TestBrowser {
  readonly cookies = new Map<string, string>();
  readonly ip = `198.51.100.${nextIp++ % 250}`;

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
      ...extraHeaders,
    };
    if (this.cookies.size > 0)
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.app.request(`${this.publicUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
    return { status: res.status, json };
  }

  get = (path: string, headers?: Record<string, string>) =>
    this.request("GET", path, undefined, headers);
  post = (path: string, body: unknown = {}) => this.request("POST", path, body);
  put = (path: string, body: unknown = {}) => this.request("PUT", path, body);
  patch = (path: string, body: unknown = {}) => this.request("PATCH", path, body);
  delete = (path: string) => this.request("DELETE", path);
}
