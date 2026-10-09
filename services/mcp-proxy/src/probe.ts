import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { apiKeyHeaders } from "./credentials.js";
import type { UpstreamClient } from "./upstream.js";

/**
 * The server's pinning probe (KOBE-101): `POST /internal/v1/probe {url}` returns the connector's
 * live `tools/list`, fetched through the same upstream client (address policy, size and time caps)
 * the sandboxes' calls use. Only the server's internal key may call it; sandboxes cannot, and the
 * answer goes to the server, which pins it, never to a sandbox. Without an `api_key` in the request
 * no credentials are attached, so connectors that need a grant answer `auth_required`.
 */
export interface ProbeDeps {
  readonly internalKey: string;
  readonly upstream: UpstreamClient;
  readonly timeoutMs: number;
  readonly maxRequestBytes: number;
}

// `api_key`: a user's grant, sent by the server to pin a connector that needs one (KOBE-108).
const bodySchema = z.strictObject({
  url: z.string().min(1).max(2048),
  api_key: z
    .string()
    .regex(/^[\x21-\x7e]{1,2048}$/)
    .optional(),
});

function keyMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function probeRoutes(deps: ProbeDeps): Hono {
  const app = new Hono();
  app.post(
    "/",
    bodyLimit({
      maxSize: deps.maxRequestBytes,
      onError: (c) => c.json({ code: "too_large" }, 413),
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      if (
        !keyMatches(
          /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1],
          deps.internalKey,
        )
      ) {
        return c.json({ code: "unauthorized" }, 401);
      }
      const body = bodySchema.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json({ code: "invalid_request" }, 400);
      const result = await deps.upstream.listTools({
        url: body.data.url,
        headers: body.data.api_key === undefined ? {} : apiKeyHeaders(body.data.api_key),
        signal: AbortSignal.timeout(deps.timeoutMs),
      });
      if (result.ok) return c.json({ ok: true, tools: result.result.tools });
      return c.json({ ok: false, failure: result.failure });
    },
  );
  return app;
}
