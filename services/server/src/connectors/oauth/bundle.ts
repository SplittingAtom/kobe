import { z } from "zod";

/**
 * What an OAuth grant seals (inside `connector_grants.sealed`, KOBE-109): the tokens plus what
 * KOBE-110 needs to refresh and revoke them without rediscovery. Never leaves the server except
 * the access token, to the MCP proxy.
 */
const bundleSchema = z.object({
  v: z.literal(1),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  client_id: z.string(),
  client_secret: z.string().optional(),
  token_endpoint: z.string(),
  issuer: z.string(),
  resource: z.string(),
});
export type OauthBundle = z.infer<typeof bundleSchema>;

export function serializeOauthBundle(bundle: Omit<OauthBundle, "v">): string {
  return JSON.stringify({ v: 1, ...bundle });
}

/** The access token of a sealed bundle; throws when the bundle is malformed. */
export function parseOauthBundle(plaintext: string): string {
  return bundleSchema.parse(JSON.parse(plaintext)).access_token;
}
