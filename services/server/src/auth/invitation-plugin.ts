import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import type { KobeDb } from "@kobe/db";
import { acceptInvite, findInviteByToken } from "../invitations/install-invites.js";

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

const tokenSchema = z.string().max(128);
const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u);

/** Every failure (unknown, used, revoked, expired, malformed) gets this one answer. */
const invalidInvitation = () =>
  new APIError("BAD_REQUEST", {
    code: "INVALID_INVITATION",
    message: "This invitation link is invalid or has expired. Ask an admin for a new one.",
  });

/**
 * Invitation acceptance as Better Auth endpoints (KOBE-13, spec D7 invite-only), so they share its
 * origin check, Postgres rate limits (per client IP) and session handling:
 * - POST /api/auth/invitation/lookup {token} → the invited email, for the accept page;
 * - POST /api/auth/invitation/accept {token, name, password} → creates the account, consumes the
 *   invitation and signs the new user in (2FA enrollment follows if the install requires it).
 */
export function invitationPlugin({
  db,
  publicOrigin,
}: {
  readonly db: KobeDb;
  /** Acceptance signs the browser in, so it must come from the install's own pages. */
  readonly publicOrigin: string;
}) {
  return {
    id: "kobe-invitation",
    endpoints: {
      lookupInvitation: createAuthEndpoint(
        "/invitation/lookup",
        { method: "POST", body: z.object({ token: tokenSchema }) },
        async (ctx) => {
          const invite = await findInviteByToken(db, ctx.body.token);
          if (!invite) throw invalidInvitation();
          return ctx.json({ email: invite.email, expiresAt: invite.expiresAt.toISOString() });
        },
      ),
      acceptInvitation: createAuthEndpoint(
        "/invitation/accept",
        {
          method: "POST",
          body: z.object({ token: tokenSchema, name: nameSchema, password: z.string() }),
        },
        async (ctx) => {
          // Better Auth checks Origin only on requests that carry cookies; acceptance sets one
          // (login CSRF), so always require the install's own origin here.
          if (ctx.request?.headers.get("origin") !== publicOrigin) {
            throw new APIError("FORBIDDEN", { code: "INVALID_ORIGIN", message: "Invalid origin" });
          }
          const { token, name, password } = ctx.body;
          if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
            throw new APIError("BAD_REQUEST", {
              code: "INVALID_PASSWORD_LENGTH",
              message: `Use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters for the password.`,
            });
          }
          if (!(await findInviteByToken(db, token))) throw invalidInvitation();
          const passwordHash = await ctx.context.password.hash(password);
          const accepted = await acceptInvite(db, { token, name, passwordHash });
          if (!accepted) throw invalidInvitation();
          const user = await ctx.context.internalAdapter.findUserById(accepted.userId);
          const session = await ctx.context.internalAdapter.createSession(accepted.userId);
          if (!user || !session) {
            throw new APIError("INTERNAL_SERVER_ERROR", { message: "Could not sign you in." });
          }
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ user: { id: user.id, email: user.email, name: user.name } });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
