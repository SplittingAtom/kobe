import { eq, users, type KobeDb } from "@kobe/db";
import { logger } from "../../logger.js";
import { CONSOLE_PATHS } from "../../mail/console-paths.js";
import type { Mailer } from "../../mail/mailer.js";
import { oneLine } from "../../mail/messages.js";

/**
 * The submitter hears of every state change of their submission (KOBE-334, SK23): In review,
 * Changes requested (with the reviewer's note), Approved, Rejected. Sent after the decision
 * commits, off the request path; the Workbench's submissions list is the durable record (it reads
 * the Registry), so a lost email loses no information.
 */

export interface ReviewNotifyDeps {
  readonly db: KobeDb;
  readonly mailer: Mailer;
  readonly publicUrl: string;
}

export interface StateChange {
  readonly submittedBy: string | null;
  readonly name: string;
  readonly semver: string;
  readonly state: string;
  readonly note: string | null;
}

const WORDS: Readonly<Record<string, string>> = {
  in_review: "is in review",
  changes_requested: "needs changes",
  approved: "was approved into the Site catalog",
  rejected: "was rejected",
  submitted: "is waiting for a reviewer again",
};

export async function notifySubmitter(deps: ReviewNotifyDeps, change: StateChange): Promise<void> {
  const words = WORDS[change.state];
  if (!change.submittedBy || !words) return;
  const [to] = await deps.db
    .select({ email: users.email, deactivatedAt: users.deactivatedAt })
    .from(users)
    .where(eq(users.id, change.submittedBy));
  if (!to || to.deactivatedAt) return;
  const subject = `Kobe: ${oneLine(change.name, 64)} ${change.semver} ${words}`;
  const text = [
    `Your submission ${oneLine(change.name, 64)} ${change.semver} to the Site Skills Registry ${words}.`,
    ...(change.note ? ["", "The reviewer wrote:", oneLine(change.note, 1000)] : []),
    "",
    "See your submissions in the Workbench:",
    `${deps.publicUrl}${CONSOLE_PATHS.mySkills}?tab=workbench`,
  ].join("\n");
  try {
    await deps.mailer.send({ to: to.email, subject, text });
  } catch (err) {
    logger.warn({ err, userId: change.submittedBy }, "registry: review email failed");
  }
}
