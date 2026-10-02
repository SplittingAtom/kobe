import { z } from "zod";

export type SmtpSecurity = "starttls" | "tls" | "none";

export interface MailAddress {
  readonly name?: string;
  readonly address: string;
}

/** SMTP settings (spec D7: SMTP is required; invites, resets and notifications go through it). */
export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  /** starttls: upgrade required (port 587); tls: implicit TLS (465); none: plain (dev relays). */
  readonly security: SmtpSecurity;
  readonly from: MailAddress;
  readonly auth?: { readonly user: string; readonly pass: string };
}

const emailSchema = z.email();
// "Name <address>" or a bare address; no CR/LF, quotes, angle brackets or commas in the name.
const FROM_PATTERN = /^(?:([^<>",\r\n]{1,100}?)\s*<([^<>\s,]+)>|([^<>\s,"]+))$/;

/** Parses KOBE_SMTP_FROM; undefined when malformed. */
export function parseFrom(value: string): MailAddress | undefined {
  const match = FROM_PATTERN.exec(value.trim());
  if (!match) return undefined;
  const name = match[1]?.trim();
  const address = (match[2] ?? match[3] ?? "").toLowerCase();
  if (!emailSchema.safeParse(address).success) return undefined;
  return name ? { name, address } : { address };
}

const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === "" ? undefined : v));

export const smtpSchema = z
  .object({
    KOBE_SMTP_HOST: z
      .string({ error: "KOBE_SMTP_HOST is required" })
      .trim()
      .min(1, "KOBE_SMTP_HOST is required")
      .max(253)
      .regex(/^[A-Za-z0-9.:[\]-]+$/, "KOBE_SMTP_HOST must be a host name or IP address"),
    KOBE_SMTP_PORT: z.coerce
      .number({ error: "KOBE_SMTP_PORT must be a number" })
      .int("KOBE_SMTP_PORT must be an integer")
      .min(1, "KOBE_SMTP_PORT must be between 1 and 65535")
      .max(65535, "KOBE_SMTP_PORT must be between 1 and 65535")
      .default(587),
    KOBE_SMTP_SECURITY: z
      .enum(["starttls", "tls", "none"], {
        error: "KOBE_SMTP_SECURITY must be starttls, tls or none",
      })
      .default("starttls"),
    KOBE_SMTP_FROM: z.string({ error: "KOBE_SMTP_FROM is required" }).transform((v, ctx) => {
      const from = parseFrom(v);
      if (!from) {
        ctx.addIssue({
          code: "custom",
          message: 'KOBE_SMTP_FROM must be "Name <address>" or an address',
        });
        return z.NEVER;
      }
      return from;
    }),
    KOBE_SMTP_USERNAME: optionalSecret,
    KOBE_SMTP_PASSWORD: optionalSecret,
  })
  .superRefine((v, ctx) => {
    if ((v.KOBE_SMTP_USERNAME === undefined) !== (v.KOBE_SMTP_PASSWORD === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["KOBE_SMTP_PASSWORD"],
        message: "KOBE_SMTP_USERNAME and KOBE_SMTP_PASSWORD must be set together",
      });
    }
    if (v.KOBE_SMTP_SECURITY === "none" && v.KOBE_SMTP_PASSWORD !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["KOBE_SMTP_SECURITY"],
        message: "KOBE_SMTP_SECURITY=none would send SMTP credentials unencrypted",
      });
    }
  })
  .transform((v): SmtpConfig => ({
    host: v.KOBE_SMTP_HOST,
    port: v.KOBE_SMTP_PORT,
    security: v.KOBE_SMTP_SECURITY,
    from: v.KOBE_SMTP_FROM,
    ...(v.KOBE_SMTP_USERNAME !== undefined && v.KOBE_SMTP_PASSWORD !== undefined
      ? { auth: { user: v.KOBE_SMTP_USERNAME, pass: v.KOBE_SMTP_PASSWORD } }
      : {}),
  }));
