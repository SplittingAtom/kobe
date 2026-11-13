import { eq, users, type TeamRole } from "@kobe/db";
import { readAppName } from "../branding/settings.js";
import type { ServerDeps } from "../deps.js";
import { teamMemberAddedMessage } from "../mail/messages.js";

/**
 * Emails the users a Site admin just added to a team (KOBE-638), off the request path; the in-app
 * notification was written with the membership. Skipped when this process has no mail relay; a
 * failed send is logged by the background runner (the membership and the bell are the record).
 */
export function mailMembersAdded(
  deps: Pick<ServerDeps, "database" | "mailer" | "background" | "publicUrl">,
  input: {
    readonly userIds: readonly string[];
    readonly teamName: string;
    readonly role: TeamRole;
    readonly adderName: string;
  },
): void {
  if (deps.mailer.disabled || input.userIds.length === 0) return;
  // One task per recipient: a refused address doesn't stop the others.
  for (const userId of input.userIds) {
    deps.background.run(
      "team member added email failed",
      async () => {
        const db = deps.database.db;
        const [user] = await db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, userId));
        if (!user) return;
        await deps.mailer.send(
          teamMemberAddedMessage({
            to: user.email,
            adderName: input.adderName,
            teamName: input.teamName,
            role: input.role,
            appName: await readAppName(db),
            signInUrl: `${deps.publicUrl}/`,
          }),
        );
      },
      { user_id: userId },
    );
  }
}
