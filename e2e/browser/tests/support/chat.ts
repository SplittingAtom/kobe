import { expect, test as base, type Locator, type Page } from "@playwright/test";
import { RUN_START_TIMEOUT_MS, RUN_TIMEOUT_MS, SHELL_TIMEOUT_MS } from "./constants.js";

/** The chat's address parameter for the open thread (`/?thread=<id>`). */
const THREAD_PARAM = "thread";
/** The active team, recorded by the chat in local storage; the API wants it as a header. */
const TEAM_KEY = "kobe.lastTeamId";
const TEAM_HEADER = "x-kobe-team";

/**
 * One conversation in the chat, driven through roles, labels and `data-kobe-*` attributes. Every
 * thread it sees is moved to Trash when the test ends (`chat` fixture), so a run leaves the
 * deployment's thread list as it was.
 */
export class Chat {
  private readonly seen: string[] = [];

  constructor(readonly page: Page) {}

  get composer(): Locator {
    return this.page.getByRole("textbox", { name: "Message", exact: true });
  }

  get steering(): Locator {
    return this.page.locator("[data-kobe-steering]");
  }

  get list(): Locator {
    return this.page.locator('[data-kobe-scroll="messages"]');
  }

  get userMessages(): Locator {
    return this.page.locator('[data-role="user"]');
  }

  get answers(): Locator {
    return this.page.locator('[data-role="assistant"]');
  }

  /** A new conversation: the chat's root opens an empty draft. */
  async open(): Promise<void> {
    await this.page.goto("/");
    await expect(this.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  }

  async send(text: string): Promise<void> {
    await this.composer.fill(text);
    await this.composer.press("Enter");
  }

  /** Sends a message and waits for its answer to finish; returns the thread's id. */
  async ask(text: string): Promise<string> {
    const before = await this.answers.count();
    await this.send(text);
    const id = await this.threadId();
    await expect
      .poll(() => this.answers.count(), { timeout: RUN_TIMEOUT_MS, intervals: [1_000] })
      .toBeGreaterThan(before);
    await this.waitForIdle();
    return id;
  }

  /** The open thread's id from the address, remembered for clean-up. */
  async threadId(): Promise<string> {
    let id: string | null = null;
    await expect
      .poll(
        () => {
          id = new URL(this.page.url()).searchParams.get(THREAD_PARAM);
          return id;
        },
        { timeout: RUN_START_TIMEOUT_MS },
      )
      .toBeTruthy();
    const found = id as unknown as string;
    if (!this.seen.includes(found)) this.seen.push(found);
    return found;
  }

  /** Waits until the panel is non-idle (a run or queue holds the thread), if that shows at all. */
  async waitForBusy(timeout = RUN_START_TIMEOUT_MS): Promise<void> {
    await expect(this.steering).not.toHaveAttribute("data-state", "idle", { timeout });
  }

  /**
   * Waits until nothing runs: the steering panel idle and no answer streaming. Checked twice a
   * moment apart, so a queued message starting in between counts. ("Sent, waiting for the agent"
   * is not a signal: on gate1 it can outlive the run, see docs/ledger/KOBE-285.md.)
   */
  async waitForIdle(timeout = RUN_TIMEOUT_MS): Promise<void> {
    for (let pass = 0; pass < 2; pass += 1) {
      await expect(this.steering).toHaveAttribute("data-state", "idle", { timeout });
      await expect(this.page.locator('[data-role="assistant"][aria-busy="true"]')).toHaveCount(0, {
        timeout,
      });
      await this.page.waitForTimeout(1_500);
    }
  }

  /** Hover reveals a message's actions; `name` is the action's accessible name. */
  async messageAction(message: Locator, name: string): Promise<Locator> {
    await message.hover();
    const action = message.getByRole("button", { name, exact: true });
    await expect(action).toBeVisible();
    return action;
  }

  /** The open thread's "Conversation actions" menu (a disclosure in the bar). */
  async openThreadActions(): Promise<void> {
    // A <summary>: found by its label, since its role differs between engines.
    await this.page.getByLabel("Conversation actions", { exact: true }).click();
  }

  /**
   * Moves every thread this test opened to Trash with the chat's own API call, made from the page
   * so the browser sends the session cookie and the Origin the server's CSRF check wants.
   */
  async trashAll(): Promise<void> {
    if (this.seen.length === 0) return;
    const failures = await this.page
      .evaluate(
        async ({ ids, teamKey, teamHeader }) => {
          const team = window.localStorage.getItem(teamKey);
          const headers: Record<string, string> = team ? { [teamHeader]: team } : {};
          const failed: string[] = [];
          for (const id of ids) {
            const res = await fetch(`/v1/threads/${encodeURIComponent(id)}`, {
              method: "DELETE",
              headers,
            }).catch(() => null);
            if (!res?.ok) failed.push(`${id}: ${res?.status ?? "network error"}`);
          }
          return failed;
        },
        { ids: this.seen, teamKey: TEAM_KEY, teamHeader: TEAM_HEADER },
      )
      .catch((e: unknown) => [`all: ${String(e)}`]);
    for (const failure of failures) console.warn(`could not move thread to Trash (${failure})`);
  }
}

/** `test` with a `chat` fixture that cleans up the threads it opened. */
export const test = base.extend<{ chat: Chat }>({
  chat: async ({ page }, use) => {
    const chat = new Chat(page);
    await use(chat);
    await chat.trashAll();
  },
});

export { expect };
