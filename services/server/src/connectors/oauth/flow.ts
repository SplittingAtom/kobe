import { withTeam, type Envelope, type KobeDb } from "@kobe/db";
import { enabledConnector, storeGrant, type Subject } from "../grants.js";
import { authorizationUrl, exchangeCode, obtainClient, type KobeOrigin } from "./client.js";
import { serializeOauthBundle } from "./bundle.js";
import { discoverAuthServer } from "./discovery.js";
import { OauthError, type OauthIo } from "./http.js";
import { newVerifier } from "./pkce.js";
import { openState, sealState } from "./state.js";

/**
 * The per-user OAuth connect flow (KOBE-109, MCP authorization spec 2026-07-28). `startFlow`
 * discovers the authorization server from the connector's MCP URL, picks a client (CIMD or DCR),
 * and returns the URL to send the browser to; `finishFlow` runs when the browser comes back,
 * checks state and `iss`, exchanges the code server-side and seals the tokens. Neither the
 * tokens, the verifier nor the code is returned or logged.
 */
export interface OauthFlowDeps {
  readonly db: KobeDb;
  readonly envelope: Envelope;
  readonly io: OauthIo;
  readonly kobe: KobeOrigin;
  readonly now: () => Date;
}

export type StartOutcome =
  | { readonly ok: true; readonly authorizationUrl: string }
  | { readonly ok: false; readonly failure: "not_available" | "not_oauth" | OauthError["code"] };

async function connectorFor(db: KobeDb, subject: Subject) {
  return withTeam(db, subject.teamId, (tx) => enabledConnector(tx, subject));
}

export async function startFlow(deps: OauthFlowDeps, subject: Subject): Promise<StartOutcome> {
  const connector = await connectorFor(deps.db, subject);
  if (!connector) return { ok: false, failure: "not_available" };
  if (connector.authKind !== "oauth") return { ok: false, failure: "not_oauth" };
  try {
    const info = await discoverAuthServer(deps.io, connector.url);
    const client = await obtainClient(deps.io, info, deps.kobe);
    const verifier = newVerifier();
    const state = sealState(
      deps.envelope,
      subject,
      {
        verifier,
        resource: info.resource,
        issuer: info.issuer,
        issRequired: info.issParameterSupported,
        tokenEndpoint: info.tokenEndpoint,
        clientId: client.clientId,
        ...(client.clientSecret === undefined ? {} : { clientSecret: client.clientSecret }),
      },
      deps.now(),
    );
    return {
      ok: true,
      authorizationUrl: authorizationUrl({
        info,
        client,
        redirectUri: deps.kobe.redirectUri,
        state,
        verifier,
      }),
    };
  } catch (error) {
    if (error instanceof OauthError) return { ok: false, failure: error.code };
    throw error;
  }
}

export interface CallbackParams {
  readonly state: string;
  readonly code: string | undefined;
  readonly iss: string | undefined;
  /** The authorization server's `error` parameter, if it refused. */
  readonly error: string | undefined;
}

export type FinishOutcome =
  | { readonly ok: true; readonly connectorId: string }
  | {
      readonly ok: false;
      readonly connectorId: string | undefined;
      readonly failure: OauthError["code"] | "access_denied" | "not_available";
    };

/**
 * `userId` and `activeTeamId` come from the session. The state must open for exactly that user and
 * name that team; the connector comes from the state, never from other parameters.
 */
export async function finishFlow(
  deps: OauthFlowDeps,
  session: { readonly userId: string; readonly activeTeamId: string },
  params: CallbackParams,
): Promise<FinishOutcome> {
  let opened;
  try {
    opened = openState(deps.envelope, params.state, session.userId, deps.now());
    if (opened.subject.teamId !== session.activeTeamId) throw new OauthError("invalid_state");
  } catch {
    return { ok: false, connectorId: undefined, failure: "invalid_state" };
  }
  const { subject, payload } = opened;
  const fail = (failure: Extract<FinishOutcome, { ok: false }>["failure"]): FinishOutcome => ({
    ok: false,
    connectorId: subject.connectorId,
    failure,
  });
  if (params.error !== undefined) return fail("access_denied");
  // RFC 9207: a response from another issuer (mix-up) is refused; so is a missing iss when the
  // server said it sends one.
  if (params.iss !== undefined ? params.iss !== payload.issuer : payload.issRequired) {
    return fail("iss_mismatch");
  }
  if (params.code === undefined || params.code === "") return fail("token_exchange_failed");
  try {
    const tokens = await exchangeCode(deps.io, {
      tokenEndpoint: payload.tokenEndpoint,
      resource: payload.resource,
      client: { clientId: payload.clientId, clientSecret: payload.clientSecret },
      redirectUri: deps.kobe.redirectUri,
      code: params.code,
      verifier: payload.verifier,
      now: deps.now(),
    });
    const stored = await storeGrant(deps.db, deps.envelope, subject, {
      kind: "oauth",
      hint: "••••",
      ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
      plaintext: serializeOauthBundle({
        access_token: tokens.accessToken,
        ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
        ...(tokens.scope ? { scope: tokens.scope } : {}),
        client_id: payload.clientId,
        ...(payload.clientSecret ? { client_secret: payload.clientSecret } : {}),
        token_endpoint: payload.tokenEndpoint,
        issuer: payload.issuer,
        resource: payload.resource,
      }),
    });
    return stored.ok ? { ok: true, connectorId: subject.connectorId } : fail("not_available");
  } catch (error) {
    if (error instanceof OauthError) return fail(error.code);
    throw error;
  }
}
