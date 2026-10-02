import { describe, expect, it } from "vitest";
import { parseFrom } from "./config.js";
import { smtpTransportOptions } from "./mailer.js";
import {
  installInviteMessage,
  oneLine,
  passwordResetMessage,
  teamInviteMessage,
} from "./messages.js";

const base = { host: "smtp.example.com", port: 587, from: { address: "k@example.com" } } as const;

describe("smtpTransportOptions", () => {
  it("requires STARTTLS by default and always verifies certificates", () => {
    const o = smtpTransportOptions({ ...base, security: "starttls" });
    expect(o).toMatchObject({ secure: false, requireTLS: true, ignoreTLS: false });
    expect(o.tls.rejectUnauthorized).toBe(true);
    expect(o).not.toHaveProperty("auth");
  });

  it("uses implicit TLS for tls and plain SMTP only for none", () => {
    expect(smtpTransportOptions({ ...base, security: "tls" })).toMatchObject({
      secure: true,
      requireTLS: false,
    });
    expect(smtpTransportOptions({ ...base, security: "none" })).toMatchObject({
      secure: false,
      requireTLS: false,
      ignoreTLS: true,
    });
  });

  it("passes credentials when configured", () => {
    expect(
      smtpTransportOptions({ ...base, security: "tls", auth: { user: "u", pass: "p" } }).auth,
    ).toEqual({ user: "u", pass: "p" });
  });
});

describe("parseFrom", () => {
  it("parses a display name and lower-cases the address", () => {
    expect(parseFrom("Kobe Mail <Kobe@Example.com>")).toEqual({
      name: "Kobe Mail",
      address: "kobe@example.com",
    });
  });
});

describe("messages", () => {
  it("keeps user-supplied names on one line in subjects", () => {
    expect(oneLine("Eve\r\nBcc: victim@example.com")).toBe("Eve Bcc: victim@example.com");
    expect(oneLine("x".repeat(300)).length).toBe(100);
    const m = teamInviteMessage({
      to: "a@b.test",
      inviterName: "Eve\nX-Evil: 1",
      teamName: "Fin\rance",
      role: "builder",
      signInUrl: "https://kobe.test/",
    });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.text).toContain("as a builder");
  });

  it("puts tokens in the link only", () => {
    const invite = installInviteMessage({
      to: "a@b.test",
      inviterName: "Owner",
      link: "https://kobe.test/invite#token=abc",
      expiresAt: new Date("2026-10-05T00:00:00Z"),
    });
    expect(invite.subject).not.toContain("abc");
    expect(invite.text).toContain("https://kobe.test/invite#token=abc");
    const reset = passwordResetMessage({
      to: "a@b.test",
      link: "https://kobe.test/reset-password#token=xyz",
      expiresInMinutes: 30,
    });
    expect(reset.subject).not.toContain("xyz");
    expect(reset.text).toContain("30 minutes");
  });
});
