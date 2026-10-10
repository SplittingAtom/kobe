import { randomBytes } from "node:crypto";
import { SESSION_TOKEN_AUDIENCES, type SessionTokenAudience } from "@kobe/protocol";
import {
  SESSION_TOKEN_TTL_SECONDS,
  SessionTokenError,
  signSessionToken,
  verifySessionToken,
} from "@kobe/session-token";
import type { SessionKeys } from "./config.js";

/**
 * Sandbox session tokens: the rules (HS256 pinned, one key per audience, 15 min TTL) and the
 * sign/verify implementation live in @kobe/session-token, shared with every verifying service
 * (egress proxy, MCP proxy, model gateway). The server mints one token per audience here.
 */
export { SESSION_TOKEN_TTL_SECONDS, SessionTokenError, signSessionToken, verifySessionToken };

export interface SandboxPrincipal {
  readonly sandboxId: string;
  readonly teamId: string;
  readonly userId: string;
}

export type IssuedSessionTokens = {
  readonly expiresAt: Date;
  readonly tokens: Readonly<Record<SessionTokenAudience, string>>;
};

/**
 * One token per audience for a sandbox, all expiring together. `ttlSeconds` is the install's
 * KOBE_SESSION_TOKEN_TTL_SECONDS (15 min unless a test install shortens it).
 */
export function issueSessionTokens(
  principal: SandboxPrincipal,
  keys: SessionKeys,
  now: Date = new Date(),
  ttlSeconds: number = SESSION_TOKEN_TTL_SECONDS,
): IssuedSessionTokens {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + ttlSeconds;
  const tokens = Object.fromEntries(
    SESSION_TOKEN_AUDIENCES.map((aud) => [
      aud,
      signSessionToken(
        {
          iss: "kobe-server",
          aud,
          sub: principal.sandboxId,
          team_id: principal.teamId,
          user_id: principal.userId,
          iat,
          exp,
          jti: randomBytes(18).toString("base64url"),
        },
        keys[aud],
      ),
    ]),
  ) as Record<SessionTokenAudience, string>;
  return { expiresAt: new Date(exp * 1000), tokens };
}
