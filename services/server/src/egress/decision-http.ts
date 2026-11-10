import type { Context } from "hono";
import { z } from "zod";
import type { ServerDeps } from "../deps.js";
import { deliverEgressRequestNotifications } from "./request-notify.js";
import { decideEgressRequest, type DecideInput } from "./request-store.js";

/**
 * Body of a decision on an access request from the blocked card or the Site console (KOBE-602,
 * EA2, EA3). `pattern` and `internal` only matter when approving.
 */
export const decisionWithPatternBodySchema = z.strictObject({
  decision: z.enum(["approve", "deny"]),
  pattern: z.string().min(1).max(300).optional(),
  internal: z.boolean().optional(),
});

export const DECISION_BODY_HINT =
  'Send {"decision": "approve" | "deny", "pattern"?: "<host or *.parent>", "internal"?: true}.';

/** Runs the decision and maps the outcome to the HTTP response (shared by every decision route). */
export async function decideAndRespond(
  c: Context,
  deps: ServerDeps,
  input: DecideInput,
): Promise<Response> {
  const result = await decideEgressRequest(deps.database.db, input);
  switch (result.kind) {
    case "not_found":
      return c.json({ code: "request_not_found", message: "That request does not exist." }, 404);
    case "site_admin_required":
      return c.json(
        {
          code: "site_admin_required",
          message:
            "Only a site admin can decide this request: the domain is outside the site's egress ceiling.",
        },
        403,
      );
    case "internal_not_allowed":
      return c.json(
        {
          code: "internal_not_allowed",
          message: "Only a site admin can mark a domain internal (same cluster).",
        },
        403,
      );
    case "pattern_invalid":
      return c.json({ code: "invalid_pattern", message: `The pattern ${result.reason}.` }, 422);
    case "pattern_not_covering":
      return c.json(
        {
          code: "pattern_not_covering",
          message: "The pattern must be the requested host or a wildcard of one of its parents.",
        },
        422,
      );
    case "not_in_ceiling":
      return c.json(
        {
          code: "not_in_ceiling",
          message: "That domain is not in the site's egress ceiling. Ask a site admin.",
        },
        409,
      );
    case "too_many_domains":
      return c.json(
        {
          code: "too_many_domains",
          message: "The ceiling has reached its domain limit. Remove one first.",
        },
        409,
      );
    case "already_decided":
      return c.json(
        {
          code: "already_decided",
          message: `That request was already ${result.request.status}.`,
          request: result.request,
        },
        409,
      );
    case "decided":
      deps.background.run(
        "egress request notification failed",
        () => deliverEgressRequestNotifications(deps, input.teamId),
        { team: input.teamId },
      );
      return c.json({
        request: result.request,
        settled: result.settled,
        enabled: result.enabled,
        pattern: result.pattern,
        ceiling: result.ceiling,
        internal: result.internal,
      });
  }
}
