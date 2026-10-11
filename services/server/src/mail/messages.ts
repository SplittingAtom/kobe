import type { MailMessage } from "./mailer.js";

/** Collapses control characters (CR/LF included) and trims, so values can't break a header. */
export function oneLine(value: string, max = 100): string {
  const flat = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const ROLE_NAMES = { team_admin: "team admin", builder: "builder", member: "member" } as const;

export function siteInviteMessage(input: {
  readonly to: string;
  readonly inviterName: string;
  readonly link: string;
  readonly expiresAt: Date;
}): MailMessage {
  const inviter = oneLine(input.inviterName);
  return {
    to: input.to,
    subject: `${inviter} invited you to Kobe`,
    text: [
      `${inviter} invited you to join Kobe.`,
      "",
      "Open this link to set your password and sign in:",
      input.link,
      "",
      `The link works once and expires on ${input.expiresAt.toUTCString()}.`,
      "If you weren't expecting this invitation, you can ignore this email.",
    ].join("\n"),
  };
}

export function teamInviteMessage(input: {
  readonly to: string;
  readonly inviterName: string;
  readonly teamName: string;
  readonly role: keyof typeof ROLE_NAMES;
  readonly signInUrl: string;
}): MailMessage {
  const inviter = oneLine(input.inviterName);
  const team = oneLine(input.teamName);
  return {
    to: input.to,
    subject: `${inviter} invited you to the ${team} team on Kobe`,
    text: [
      `${inviter} invited you to join the ${team} team on Kobe as a ${ROLE_NAMES[input.role]}.`,
      "",
      `Sign in to accept or decline: ${input.signInUrl}`,
    ].join("\n"),
  };
}

export function passwordResetMessage(input: {
  readonly to: string;
  readonly link: string;
  readonly expiresInMinutes: number;
}): MailMessage {
  return {
    to: input.to,
    subject: "Reset your Kobe password",
    text: [
      "Someone asked to reset the password of your Kobe account.",
      "",
      "Open this link to choose a new password:",
      input.link,
      "",
      `The link works once and expires in ${input.expiresInMinutes} minutes. Resetting your password`,
      "signs you out everywhere. If you didn't ask for this, ignore this email; your password stays",
      "the same.",
    ].join("\n"),
  };
}

/** What a scheduled run's end email says it was (KOBE-179). */
export type ScheduledRunOutcome = "succeeded" | "failed" | "interrupted" | "skipped_actions";

const OUTCOME_SUBJECT: Readonly<Record<ScheduledRunOutcome, string>> = {
  succeeded: "succeeded",
  failed: "failed",
  interrupted: "was interrupted",
  skipped_actions: "finished with skipped actions",
};

/**
 * A scheduled run ended (spec D32, KOBE-179). Metadata only: the outcome, the team, when the
 * schedule runs, the skipped-action count and links. Never the prompt, the thread title or any
 * output; the thread holds the content.
 */
export function scheduledRunMessage(input: {
  readonly to: string;
  readonly outcome: ScheduledRunOutcome;
  readonly teamName: string;
  /** e.g. "daily at 09:00 (Europe/Berlin)"; null when the schedule is gone. */
  readonly when: string | null;
  readonly skippedCount: number | null;
  readonly threadLink: string;
  readonly schedulesLink: string;
}): MailMessage {
  const team = oneLine(input.teamName);
  const when = input.when === null ? "" : ` (${oneLine(input.when)})`;
  const outcome = OUTCOME_SUBJECT[input.outcome];
  const skipped = input.skippedCount ?? 0;
  return {
    to: input.to,
    subject: `Your scheduled run ${outcome} in the ${team} team`,
    text: [
      `Your scheduled run${when} in the ${team} team on Kobe ${outcome}.`,
      ...(skipped > 0
        ? [
            `${skipped === 1 ? "1 tool call was" : `${skipped} tool calls were`} skipped: scheduled runs do not wait for approval.`,
          ]
        : []),
      "",
      `Open the thread: ${input.threadLink}`,
      `Manage your schedules: ${input.schedulesLink}`,
    ].join("\n"),
  };
}
