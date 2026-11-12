import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import type { KobeDb } from "@kobe/db";
import { logger } from "../logger.js";
import { LinkIntentBox, consumeLinkIntent } from "../sso/link-intent.js";
import { linkByLocalProof } from "../sso/linking.js";
import { stagePendingLink } from "../sso/pending-link.js";
import type { SsoSettings } from "../sso/settings.js";
import { linkIntentCookieName } from "./sso-plugin.js";

/** Local sign-in endpoints that end in a session (the proof of §6's local-proof flow). */
const LOCAL_SIGN_IN = new Set([
  "/sign-in/email",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/passkey/verify-authentication",
]);
/** With a session these are enrolment or a re-check, never a sign-in. */
const TWO_FACTOR_STEP = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);

export interface SsoLinkPluginOptions {
  readonly db: KobeDb;
  readonly publicOrigin: string;
  readonly secret: string;
  /** Kill switch: with SSO off an intent is discarded, never used. */
  readonly settings: SsoSettings | undefined;
}

/**
 * The local-proof half of account linking (spec sso-oidc-scim §6, KOBE-630). After a local sign-in
 * that **completes** (a password without TOTP, the TOTP or backup-code step of a pending sign-in,
 * or a passkey) in a browser holding a link intent, the intent is spent: when the signed-in
 * user's address equals the intent's, the identity is staged for that session and linked only
 * once the person confirms it (`/v1/me/sso/pending-link`, review M1); otherwise it is discarded. A failed
 * attempt or a pending TOTP challenge keeps the intent for the next try; enrolment with a session
 * never counts. Register after the two-factor and passkey plugins: the two-factor after hook turns
 * a password sign-in with TOTP into a challenge (no `newSession`), which must be seen here.
 */
export function ssoLinkPlugin(options: SsoLinkPluginOptions) {
  const box = new LinkIntentBox(options.secret);
  const secure = new URL(options.publicOrigin).protocol === "https:";
  const cookieName = linkIntentCookieName(secure);
  const cookieOptions = { httpOnly: true, secure, sameSite: "lax" as const, path: "/" };
  // Requests whose 2FA step ran with a session already (enrolment): keyed by the shared Request.
  const enrolment = new WeakSet<object>();

  return {
    id: "kobe-sso-link",
    hooks: {
      before: [
        {
          matcher: (ctx) => TWO_FACTOR_STEP.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            if (!ctx.request || !ctx.getCookie(cookieName)) return;
            const session = await getSessionFromCtx(ctx).catch(() => null);
            if (session) enrolment.add(ctx.request);
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => LOCAL_SIGN_IN.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const sealed = ctx.getCookie(cookieName);
            if (!sealed) return;
            if (isAPIError(ctx.context.returned)) return;
            const signedIn = ctx.context.newSession;
            if (!signedIn) return;
            if (ctx.request && enrolment.has(ctx.request)) return;
            // Spent by this sign-in, whatever follows (a different user discards it).
            ctx.setCookie(cookieName, "", { ...cookieOptions, maxAge: 0 });
            if (!options.settings?.enabled) return;
            const intent = box.open(sealed);
            if (!intent) return;
            try {
              if (!(await consumeLinkIntent(options.db, intent))) return;
              const userId = signedIn.user.id;
              const outcome = await linkByLocalProof(options.db, intent, userId, { commit: false });
              if (outcome === "ready") {
                // Nothing is linked yet: the person confirms on the next screen (review M1).
                await stagePendingLink(options.db, signedIn.session.id, intent, userId);
              } else {
                logger.info({ outcome }, "single sign-on link intent discarded");
              }
            } catch (err) {
              // The local sign-in stands; only the link is not made.
              logger.error({ err: { name: (err as Error)?.name } }, "single sign-on link failed");
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
