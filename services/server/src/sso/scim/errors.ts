import type { Context } from "hono";
import { ERROR_SCHEMA, SCIM_CONTENT_TYPE, type ScimType } from "./schemas.js";

/** A SCIM resource or error body, sent as `application/scim+json` and never cached. */
export function scimJson(c: Context, body: unknown, status: number = 200): Response {
  c.header("Cache-Control", "no-store");
  return c.body(JSON.stringify(body), status as 200, { "Content-Type": SCIM_CONTENT_TYPE });
}

/** An RFC 7644 §3.12 error: `status` as a string, an optional `scimType`, a human `detail`. */
export function scimError(
  c: Context,
  status: number,
  detail: string,
  scimType?: ScimType,
): Response {
  return scimJson(
    c,
    {
      schemas: [ERROR_SCHEMA],
      status: String(status),
      ...(scimType ? { scimType } : {}),
      detail,
    },
    status,
  );
}
