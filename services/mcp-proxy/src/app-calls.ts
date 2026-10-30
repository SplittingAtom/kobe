import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { apiKeyHeaders, oauthHeaders } from "./credentials.js";
import { keyMatches } from "./internal-key.js";
import type { UpstreamClient } from "./upstream.js";

/**
 * An MCP App's own `tools/call` (KOBE-436, spec §6): `POST /internal/v1/app-calls`. Only the
 * server's internal key may call it: the server has already decided the call under the viewing
 * member's browser principal (read-only, app-visible, exposed, policy, audit) and revealed the
 * member's credential (their grant or the site key), which comes here and goes only to the
 * upstream, never back. Same upstream client as the sandboxes' calls: address policy, size and
 * time caps. The sandbox is not involved and cannot reach this route (internal key only).
 */
export interface AppCallDeps {
  readonly internalKey: string;
  readonly upstream: UpstreamClient;
  readonly timeoutMs: number;
}

/** Arguments are capped at 64 KiB by the server; the body allows a little more for the rest. */
export const APP_CALL_MAX_BODY = 96 * 1024;

const bodySchema = z
  .strictObject({
    connector_id: z.uuid(),
    url: z.string().min(1).max(2048),
    tool: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
    arguments: z.record(z.string(), z.unknown()),
    api_key: z
      .string()
      .regex(/^[\x21-\x7e]{1,2048}$/)
      .optional(),
    access_token: z
      .string()
      .regex(/^[\x21-\x7e]{1,8192}$/)
      .optional(),
  })
  .refine((b) => b.api_key === undefined || b.access_token === undefined);

export function appCallRoutes(deps: AppCallDeps): Hono {
  const app = new Hono();
  app.post(
    "/",
    bodyLimit({
      maxSize: APP_CALL_MAX_BODY,
      onError: (c) => c.json({ code: "too_large" }, 413),
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      if (!keyMatches(c.req.header("authorization"), deps.internalKey)) {
        return c.json({ code: "unauthorized" }, 401);
      }
      const body = bodySchema.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) return c.json({ code: "invalid_request" }, 400);
      const b = body.data;
      const headers =
        b.api_key !== undefined
          ? apiKeyHeaders(b.api_key)
          : b.access_token !== undefined
            ? oauthHeaders(b.access_token)
            : {};
      const result = await deps.upstream.callTool({
        url: b.url,
        kind: "app",
        headers,
        tool: b.tool,
        arguments: b.arguments,
        signal: AbortSignal.timeout(deps.timeoutMs),
      });
      if (result.ok) return c.json({ ok: true, result: result.result });
      if (result.failure === "rpc_error") {
        return c.json({
          ok: false,
          failure: "rpc_error",
          code: result.code,
          message: result.message,
        });
      }
      return c.json({ ok: false, failure: result.failure });
    },
  );
  return app;
}
