import { tokenRequestHeaders, tokenSchema, type TokenSet } from "./client.js";
import type { OauthBundle } from "./bundle.js";
import { OauthError, oauthRequest, type OauthIo } from "./http.js";

/** Token endpoint errors that mean this refresh token will never work again (RFC 6749 5.2). */
const DEAD_GRANT_ERRORS = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);

/**
 * Exchanges the stored refresh token for a new access token (RFC 6749 6, with the RFC 8707
 * resource). Goes through the same pinned-address, no-redirect, size- and time-capped client as
 * every other OAuth request. The token endpoint is the one sealed with the grant, not
 * re-discovered. Throws {@link OauthError}: `refresh_rejected` when the server says the grant is
 * dead (the user must reconnect), anything else (unreachable, 5xx, garbage) is transient.
 * A rotated refresh token comes back in `refreshToken`; `undefined` means keep the old one.
 */
export async function refreshAccessToken(
  io: OauthIo,
  bundle: OauthBundle,
  now: Date,
): Promise<TokenSet> {
  if (bundle.refresh_token === undefined) throw new OauthError("refresh_rejected");
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: bundle.refresh_token,
    resource: bundle.resource,
  });
  const headers = tokenRequestHeaders(form, {
    clientId: bundle.client_id,
    clientSecret: bundle.client_secret,
  });
  const res = await oauthRequest(
    io,
    bundle.token_endpoint,
    { method: "POST", headers, body: form.toString() },
    "token_exchange_failed",
  );
  const error = (res.json as { error?: unknown } | undefined)?.error;
  if (res.status >= 400 && res.status < 500 && typeof error === "string") {
    if (DEAD_GRANT_ERRORS.has(error)) throw new OauthError("refresh_rejected");
  }
  const parsed = tokenSchema.safeParse(res.json);
  if (res.status !== 200 || !parsed.success) throw new OauthError("token_exchange_failed");
  const t = parsed.data;
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    scope: t.scope,
    expiresAt:
      t.expires_in === undefined ? undefined : new Date(now.getTime() + t.expires_in * 1000),
  };
}
