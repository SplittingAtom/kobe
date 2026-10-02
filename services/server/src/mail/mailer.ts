import nodemailer from "nodemailer";
import type { MailAddress, SmtpConfig } from "./config.js";

/** One plain-text email. Plain text only: user-supplied names are never rendered as HTML. */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface Mailer {
  /** Resolves once the SMTP server accepted the message; rejects otherwise. */
  send(message: MailMessage): Promise<void>;
  close(): void;
}

/** Nodemailer SMTP options for a config. TLS certificates are always verified. */
export function smtpTransportOptions(config: SmtpConfig) {
  return {
    host: config.host,
    port: config.port,
    // Implicit TLS on connect (465), or a required STARTTLS upgrade (587). "none" is for dev relays.
    secure: config.security === "tls",
    requireTLS: config.security === "starttls",
    ignoreTLS: config.security === "none",
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" as const },
    ...(config.auth ? { auth: { user: config.auth.user, pass: config.auth.pass } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    pool: true,
    maxConnections: 2,
  };
}

const formatFrom = (from: MailAddress) =>
  from.name ? { name: from.name, address: from.address } : from.address;

export function createSmtpMailer(config: SmtpConfig): Mailer {
  const transport = nodemailer.createTransport(smtpTransportOptions(config));
  return {
    async send({ to, subject, text }) {
      await transport.sendMail({ from: formatFrom(config.from), to, subject, text });
    },
    close: () => transport.close(),
  };
}
