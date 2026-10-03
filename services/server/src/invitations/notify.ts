import { and, eq, isNull, users, type TeamRole } from "@kobe/db";
import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import { installInviteMessage, teamInviteMessage } from "../mail/messages.js";
import type { IssuedInvite } from "./install-invites.js";

/** Mails an install invitation; false when the SMTP server refused or was unreachable. */
export async function mailInstallInvite(
  deps: ServerDeps,
  invite: IssuedInvite,
  inviterName: string,
): Promise<boolean> {
  try {
    await deps.mailer.send(
      installInviteMessage({
        to: invite.email,
        inviterName,
        // In the fragment: never sent to the server or proxies, so never in access logs.
        link: `${deps.publicUrl}/invite#token=${invite.token}`,
        expiresAt: invite.expiresAt,
      }),
    );
    return true;
  } catch (err) {
    logger.error({ err, invitationId: invite.id }, "invitation email failed");
    return false;
  }
}

/**
 * Tells an existing, active user about a team invitation. Runs off the request path, so the team
 * admin's response (and its timing) doesn't reveal whether the address belongs to a Kobe user.
 */
export function notifyTeamInvite(
  deps: ServerDeps,
  input: {
    readonly email: string;
    readonly teamName: string;
    readonly role: TeamRole;
    readonly inviterName: string;
  },
): void {
  const send = async () => {
    const [user] = await deps.database.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, input.email), isNull(users.deactivatedAt)));
    if (!user) return;
    await deps.mailer.send(
      teamInviteMessage({ to: input.email, ...input, signInUrl: `${deps.publicUrl}/` }),
    );
  };
  deps.background.run("team invitation email failed", send);
}
