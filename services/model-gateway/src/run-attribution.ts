import { RUN_TOKEN_HEADER } from "@kobe/protocol";
import { verifyRunToken } from "@kobe/protocol/node";
import type { IncomingHttpHeaders } from "node:http";
import type { GatewayOptions } from "./gateway.js";

/**
 * Which run a model call belongs to (KOBE-118, contract in KOBE-117). Order:
 *
 * 1. `x-kobe-run-token` present: it must verify (MAC, shape, time; else 401, never a fallback to
 *    the advisory header), name this very team and sandbox (the session token's), still be active
 *    in the server's record (not revoked at run end, run active on this sandbox), and an
 *    `x-kobe-run-id` that disagrees is refused. The run id is then the token's, so a per-run stop
 *    (the run ends, its tokens are revoked) cannot be evaded by naming another run;
 * 2. no token and enforcement on: 401 (a run's own tools can't drop the header to dodge a stop);
 * 3. no token, enforcement off (rollout): the legacy advisory `x-kobe-run-id`, which must be an
 *    active run leased to this sandbox.
 */
export type RunAttribution =
  | { readonly ok: true; readonly runId: string | undefined }
  | {
      readonly ok: false;
      readonly status: 400 | 401 | 403;
      readonly code: string;
      readonly message: string;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const refuse = (status: 400 | 401 | 403, code: string, message: string): RunAttribution => ({
  ok: false,
  status,
  code,
  message,
});

export interface CallerIdentity {
  readonly teamId: string;
  readonly sandboxId: string;
}

export async function resolveRunAttribution(
  options: Pick<GatewayOptions, "runTokens" | "isRunLeased">,
  headers: IncomingHttpHeaders,
  identity: CallerIdentity,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<RunAttribution> {
  const advisory = headers["x-kobe-run-id"];
  let advisoryId: string | undefined;
  if (advisory !== undefined) {
    if (typeof advisory !== "string" || !UUID.test(advisory)) {
      return refuse(400, "invalid_run_id", "x-kobe-run-id must be a run id.");
    }
    advisoryId = advisory.toLowerCase();
  }
  const { runTokens } = options;
  const presented = headers[RUN_TOKEN_HEADER];
  if (presented === undefined) {
    if (runTokens.require) {
      return refuse(401, "run_token_required", `A ${RUN_TOKEN_HEADER} header is required.`);
    }
    if (advisoryId === undefined) return { ok: true, runId: undefined };
    return (await options.isRunLeased(identity.teamId, advisoryId, identity.sandboxId))
      ? { ok: true, runId: advisoryId }
      : refuse(403, "run_not_leased", "That run is not active on this sandbox.");
  }
  const verified = verifyRunToken(runTokens.key, presented, nowSeconds);
  if (!verified.ok) {
    return refuse(401, "invalid_run_token", "A valid run token is required.");
  }
  const claims = verified.claims;
  if (claims.team_id !== identity.teamId || claims.sandbox_id !== identity.sandboxId) {
    return refuse(403, "run_token_mismatch", "That run token belongs to another sandbox.");
  }
  if (advisoryId !== undefined && advisoryId !== claims.run_id) {
    return refuse(403, "run_id_mismatch", "x-kobe-run-id does not match the run token.");
  }
  const active = await runTokens.isActive({
    teamId: claims.team_id,
    jti: claims.jti,
    runId: claims.run_id,
    sandboxId: claims.sandbox_id,
  });
  return active
    ? { ok: true, runId: claims.run_id }
    : refuse(403, "run_token_inactive", "That run has ended or its token was revoked.");
}
