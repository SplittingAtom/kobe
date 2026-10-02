import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { eq, users, type KobeDb } from "@kobe/db";
import { recordAuditAfter, type ServerAuditEvent } from "./record.js";

type AuthCtx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];
type SignInMethod = "password" | "totp" | "backup_code" | "passkey" | "invitation";

/** Endpoints that end in a session (spec D7 sign-in methods). */
const SIGN_IN: Readonly<Record<string, SignInMethod>> = {
  "/sign-in/email": "password",
  "/two-factor/verify-totp": "totp",
  "/two-factor/verify-backup-code": "backup_code",
  "/passkey/verify-authentication": "passkey",
  "/invitation/accept": "invitation",
};

/** Endpoints acting on the signed-in user's own credentials: the event and its success-only rule. */
const SELF_SERVICE: Readonly<Record<string, ServerAuditEvent["action"]>> = {
  "/change-password": "auth.password.changed",
  "/two-factor/disable": "auth.two_factor.disabled",
  "/two-factor/generate-backup-codes": "auth.two_factor.backup_codes_regenerated",
  "/passkey/verify-registration": "auth.passkey.added",
  "/passkey/delete-passkey": "auth.passkey.removed",
  "/revoke-session": "auth.session.revoked",
  "/revoke-other-sessions": "auth.session.revoked",
  "/revoke-sessions": "auth.session.revoked",
};
const REVOKED = { "/revoke-session": "one", "/revoke-other-sessions": "others" } as const;

/** Paths whose outcome depends on who was signed in before the endpoint ran. */
const NEEDS_PRIOR_SESSION = new Set(["/sign-out", "/two-factor/verify-totp"]);

interface PriorSession {
  readonly userId: string;
  readonly twoFactorEnabled: boolean;
}

/** A machine-readable failure reason: Better Auth's error code, else the HTTP status name. */
function reasonOf(returned: unknown): string {
  const err = returned as { body?: { code?: unknown }; status?: unknown };
  const raw = typeof err.body?.code === "string" ? err.body.code : String(err.status ?? "ERROR");
  return raw.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64) || "ERROR";
}

const user = (id: string | null) => ({ kind: "user" as const, id });

async function userIdByEmail(db: KobeDb, email: unknown): Promise<string | null> {
  if (typeof email !== "string" || email.length > 254) return null;
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()));
  return row?.id ?? null;
}

/**
 * Audits Better Auth's endpoints (KOBE-15): sign-in success, failure and 2FA challenge, sign-out,
 * password change, 2FA and passkey changes, session revocation. Better Auth owns those writes and
 * their transactions, so each event is recorded right after the endpoint finished (best effort,
 * failures logged at error level). Register it **last** among plugins: the two-factor plugin's
 * after hook (which turns a password sign-in into a pending 2FA challenge) must run first.
 * Password reset request/completion are recorded by auth.ts (they have their own callbacks).
 */
export function auditPlugin({ db }: { readonly db: KobeDb }) {
  // Keyed by the incoming Request, which before and after hooks share; GC'd with it.
  const prior = new WeakMap<object, PriorSession>();

  async function record(ctx: AuthCtx): Promise<void> {
    const failed = isAPIError(ctx.context.returned);
    const newUserId = ctx.context.newSession?.user.id ?? null;
    const before = ctx.request ? prior.get(ctx.request) : undefined;
    const sessionUserId = ctx.context.session?.user.id ?? null;

    if (ctx.path === "/sign-out") {
      if (!failed && before) {
        await recordAuditAfter(db, {
          action: "auth.sign_out",
          actor: user(before.userId),
          target: {},
        });
      }
      return;
    }
    // TOTP verification with a session is enrollment (or a re-check), not a sign-in.
    if (ctx.path === "/two-factor/verify-totp" && before) {
      if (!failed && !before.twoFactorEnabled) {
        await recordAuditAfter(db, {
          action: "auth.two_factor.enabled",
          actor: user(before.userId),
          target: {},
        });
      }
      return;
    }
    const method = SIGN_IN[ctx.path];
    if (method) {
      const body = ctx.body as { email?: unknown } | undefined;
      if (failed) {
        const userId = method === "password" ? await userIdByEmail(db, body?.email) : null;
        await recordAuditAfter(db, {
          action: "auth.sign_in.failed",
          actor: user(null),
          target: { method, reason: reasonOf(ctx.context.returned), ...(userId ? { userId } : {}) },
        });
      } else if (newUserId) {
        await recordAuditAfter(db, {
          action: "auth.sign_in.succeeded",
          actor: user(newUserId),
          target: { method },
        });
      } else if (method === "password") {
        await recordAuditAfter(db, {
          action: "auth.sign_in.two_factor_required",
          actor: user(await userIdByEmail(db, body?.email)),
          target: { method },
        });
      }
      return;
    }
    const action = SELF_SERVICE[ctx.path];
    if (!action || failed || !sessionUserId) return;
    const target =
      action === "auth.session.revoked"
        ? { which: REVOKED[ctx.path as keyof typeof REVOKED] ?? "all" }
        : action === "auth.passkey.removed"
          ? passkeyTarget(ctx.body)
          : {};
    await recordAuditAfter(db, { action, actor: user(sessionUserId), target } as ServerAuditEvent);
  }

  return {
    id: "kobe-audit",
    hooks: {
      before: [
        {
          matcher: (ctx) => NEEDS_PRIOR_SESSION.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx).catch(() => null);
            if (session && ctx.request) {
              prior.set(ctx.request, {
                userId: session.user.id,
                twoFactorEnabled: session.user.twoFactorEnabled === true,
              });
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) =>
            ctx.path !== undefined &&
            (ctx.path in SIGN_IN || ctx.path in SELF_SERVICE || ctx.path === "/sign-out"),
          handler: createAuthMiddleware(async (ctx) => {
            await record(ctx);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

function passkeyTarget(body: unknown): { passkeyId?: string } {
  const id = (body as { id?: unknown } | undefined)?.id;
  return typeof id === "string" && id.length <= 128 ? { passkeyId: id } : {};
}
