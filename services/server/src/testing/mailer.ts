import type { MailMessage, Mailer } from "../mail/mailer.js";

/** In-memory mailer for tests (no SMTP server in tests). */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  /** When set, the next send fails with this error. */
  failNext: Error | undefined;

  async send(message: MailMessage): Promise<void> {
    const failure = this.failNext;
    this.failNext = undefined;
    if (failure) throw failure;
    this.sent.push(message);
  }

  close(): void {}

  /** Messages to one address, oldest first. */
  to(address: string): MailMessage[] {
    return this.sent.filter((m) => m.to === address.toLowerCase());
  }

  /** The token from the fragment of the newest link sent to `address` (`…#token=…`). */
  lastToken(address: string): string {
    const text = this.to(address).at(-1)?.text ?? "";
    const match = /#token=([A-Za-z0-9_-]+)/.exec(text);
    if (!match?.[1]) throw new Error(`no token mailed to ${address}`);
    return match[1];
  }

  /** Waits for fire-and-forget sends to land. */
  async settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 20));
  }
}
