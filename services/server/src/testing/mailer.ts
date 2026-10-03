import type { BackgroundTasks } from "../background.js";
import type { MailMessage, Mailer } from "../mail/mailer.js";

/** In-memory mailer for tests (no SMTP server in tests). */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  /** When set, the next send fails with this error. */
  failNext: Error | undefined;
  /** While set, sends wait for it (an SMTP server that is slow to accept). */
  hold: Promise<void> | undefined;

  /** `background`: the server's off-request-path tasks, which settle() waits on. */
  constructor(private readonly background?: BackgroundTasks) {}

  async send(message: MailMessage): Promise<void> {
    await this.hold;
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

  /**
   * Waits until the server's off-request-path work (sends and what follows them, such as recording
   * a delivered reset link) has finished: on the work itself, not a guessed delay.
   */
  async settle(): Promise<void> {
    if (!this.background)
      throw new Error("MemoryMailer.settle() needs the server's BackgroundTasks");
    await this.background.idle();
  }
}
