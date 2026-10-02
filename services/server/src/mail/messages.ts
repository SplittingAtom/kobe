import type { MailMessage } from "./mailer.js";

/** Collapses control characters (CR/LF included) and trims, so values can't break a header. */
export function oneLine(value: string, max = 100): string {
  const flat = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const ROLE_NAMES = { team_admin: "team admin", builder: "builder", member: "member" } as const;

export function installInviteMessage(input: {
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
