import type { MailMessage } from "./mailer.js";

/** Collapses control characters (CR/LF included) and trims, so values can't break a header. */
export function oneLine(value: string, max = 100): string {
  const flat = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const ROLE_NAMES = {
  team_admin: "team admin",
  contributor: "contributor",
  member: "member",
} as const;

/** Every message names the site by its configured name (`readAppName`, theming TH1). */
interface Branded {
  /** The app name (`branding.app_name`, default "Kobe"). */
  readonly appName: string;
}

export function siteInviteMessage(
  input: Branded & {
    readonly to: string;
    readonly inviterName: string;
    readonly link: string;
    readonly expiresAt: Date;
  },
): MailMessage {
  const inviter = oneLine(input.inviterName);
  const app = oneLine(input.appName);
  return {
    to: input.to,
    subject: `${inviter} invited you to ${app}`,
    text: [
      `${inviter} invited you to join ${app}.`,
      "",
      "Open this link to set your password and sign in:",
      input.link,
      "",
      `The link works once and expires on ${input.expiresAt.toUTCString()}.`,
      "If you weren't expecting this invitation, you can ignore this email.",
    ].join("\n"),
  };
}

export function teamInviteMessage(
  input: Branded & {
    readonly to: string;
    readonly inviterName: string;
    readonly teamName: string;
    readonly role: keyof typeof ROLE_NAMES;
    readonly signInUrl: string;
  },
): MailMessage {
  const inviter = oneLine(input.inviterName);
  const team = oneLine(input.teamName);
  const app = oneLine(input.appName);
  return {
    to: input.to,
    subject: `${inviter} invited you to the ${team} team on ${app}`,
    text: [
      `${inviter} invited you to join the ${team} team on ${app} as a ${ROLE_NAMES[input.role]}.`,
      "",
      `Sign in to accept or decline: ${input.signInUrl}`,
    ].join("\n"),
  };
}

/** A Site admin added an existing user to a team, no invitation (KOBE-638). */
export function teamMemberAddedMessage(
  input: Branded & {
    readonly to: string;
    readonly adderName: string;
    readonly teamName: string;
    readonly role: keyof typeof ROLE_NAMES;
    readonly signInUrl: string;
  },
): MailMessage {
  const adder = oneLine(input.adderName);
  const team = oneLine(input.teamName);
  const app = oneLine(input.appName);
  return {
    to: input.to,
    subject: `${adder} added you to the ${team} team on ${app}`,
    text: [
      `${adder}, a site admin, added you to the ${team} team on ${app} as a ${ROLE_NAMES[input.role]}.`,
      "",
      `Sign in and pick the team from the team switcher: ${input.signInUrl}`,
      "If you think this is a mistake, ask the team's admins to remove you.",
    ].join("\n"),
  };
}

/** What a Site admin did to a team's membership from the Site console (KOBE-638 review M1). */
export type SiteAdminChange = "added" | "role_changed" | "removed" | "taken_over";

/** Tells a team admin what a Site admin changed in their team's membership (review M1). */
export function siteAdminChangeMessage(
  input: Branded & {
    readonly to: string;
    readonly adminName: string;
    readonly teamName: string;
    readonly change: SiteAdminChange;
    readonly memberNames: readonly string[];
    readonly role?: keyof typeof ROLE_NAMES;
    readonly signInUrl: string;
  },
): MailMessage {
  const admin = oneLine(input.adminName);
  const team = oneLine(input.teamName);
  const app = oneLine(input.appName);
  const names = input.memberNames.map((n) => oneLine(n)).join(", ") || "a member";
  const role = input.role ? ROLE_NAMES[input.role] : null;
  const what = {
    added: `added ${names} to the ${team} team${role ? ` as ${role}` : ""}`,
    role_changed: `changed the team role of ${names} in the ${team} team${role ? ` to ${role}` : ""}`,
    removed: `removed ${names} from the ${team} team`,
    taken_over: `took over the membership of ${names} in the ${team} team from the identity provider`,
  }[input.change];
  return {
    to: input.to,
    subject: `A site admin changed the ${team} team's members on ${app}`,
    text: [
      `${admin}, a site admin, ${what} from the Site console.`,
      "",
      `You get this as a team admin of ${team}. The team's audit log has the details: ${input.signInUrl}`,
    ].join("\n"),
  };
}

export function passwordResetMessage(
  input: Branded & {
    readonly to: string;
    readonly link: string;
    readonly expiresInMinutes: number;
  },
): MailMessage {
  const app = oneLine(input.appName);
  return {
    to: input.to,
    subject: `Reset your ${app} password`,
    text: [
      `Someone asked to reset the password of your ${app} account.`,
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
export function scheduledRunMessage(
  input: Branded & {
    readonly to: string;
    readonly outcome: ScheduledRunOutcome;
    readonly teamName: string;
    /** e.g. "daily at 09:00 (Europe/Berlin)"; null when the schedule is gone. */
    readonly when: string | null;
    readonly skippedCount: number | null;
    readonly threadLink: string;
    readonly schedulesLink: string;
  },
): MailMessage {
  const team = oneLine(input.teamName);
  const when = input.when === null ? "" : ` (${oneLine(input.when)})`;
  const outcome = OUTCOME_SUBJECT[input.outcome];
  const skipped = input.skippedCount ?? 0;
  const app = oneLine(input.appName);
  return {
    to: input.to,
    subject: `Your scheduled run ${outcome} in the ${team} team`,
    text: [
      `Your scheduled run${when} in the ${team} team on ${app} ${outcome}.`,
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
