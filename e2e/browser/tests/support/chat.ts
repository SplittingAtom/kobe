import { expect, test as base, type Locator, type Page } from "@playwright/test";
import {
  RUN_START_TIMEOUT_MS,
  RUN_TIMEOUT_MS,
  SHELL_TIMEOUT_MS,
  WAITING_FOR_AGENT,
} from "./constants.js";

/** The chat's address parameter for the open thread (`/?thread=<id>`). */
const THREAD_PARAM = "thread";
/** The active team, recorded by the chat in local storage; the API wants it as a header. */
const TEAM_KEY = "kobe.lastTeamId";
const TEAM_HEADER = "x-kobe-team";
/** How long clean-up waits for a busy thread (its run or title call) to settle before Trash. */
const TRASH_SETTLE_MS = 60_000;
const TRASH_RETRY_MS = 2_000;

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

  /** A new conversation: the chat's root opens an empty draft, with the rail's Files on. */
  async open(): Promise<void> {
    await this.page.goto("/");
    await expect(this.composer).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    await this.showBothPanels();
  }

  /** The rail's top line (KOBE-419): team selector, New, Threads, Files, Team console, collapse. */
  get railHeader(): Locator {
    return this.page.locator("[data-rail-header]");
  }

  /**
   * Turns the rail's Files section on (saved per member, so another spec or device may have left it
   * off). The threads are a panel since KOBE-453 (`openThreads`). Nothing to do where the rail is
   * not on screen (a phone, collapsed).
   */
  async showBothPanels(): Promise<void> {
    const toggle = this.railHeader.getByRole("button", { name: "Files panel", exact: true });
    if (!(await toggle.isVisible())) return;
    if ((await toggle.getAttribute("aria-pressed")) === "false") await toggle.click();
  }

  /** The Threads panel over the workspace (KOBE-453). */
  get threadsPanel(): Locator {
    return this.page.getByRole("dialog", { name: "Threads" });
  }

  /**
   * Opens the Threads panel the way a member does: Threads on the rail's top line, the collapsed
   * rail's Show threads, or on a phone the drawer's Threads. Returns the panel.
   */
  async openThreads(): Promise<Locator> {
    const panel = this.threadsPanel;
    if (await panel.isVisible()) return panel;
    const line = this.railHeader.getByRole("button", { name: "Threads panel", exact: true });
    const strip = this.page.getByRole("button", { name: "Show threads", exact: true });
    if (await line.first().isVisible()) await line.first().click();
    else if (await strip.isVisible()) await strip.click();
    else {
      await this.page.getByRole("button", { name: "Show the workspace" }).click();
      await this.page
        .getByRole("dialog", { name: "Workspace" })
        .getByRole("button", { name: "Threads panel", exact: true })
        .click();
    }
    await expect(panel).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    return panel;
  }

  /** Closes the Threads panel if it is open (its Close button). */
  async closeThreads(): Promise<void> {
    const panel = this.threadsPanel;
    if (!(await panel.isVisible())) return;
    await panel.getByRole("button", { name: "Close Threads" }).click();
    await expect(panel).toBeHidden();
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
   * Waits until nothing runs: the steering panel idle, no answer streaming and no message waiting
   * for the agent. Checked twice a moment apart, so a queued message starting in between counts.
   */
  async waitForIdle(timeout = RUN_TIMEOUT_MS): Promise<void> {
    for (let pass = 0; pass < 2; pass += 1) {
      await expect(this.steering).toHaveAttribute("data-state", "idle", { timeout });
      await expect(this.page.locator('[data-role="assistant"][aria-busy="true"]')).toHaveCount(0, {
        timeout,
      });
      await expect(this.page.getByText(WAITING_FOR_AGENT)).toHaveCount(0, { timeout });
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

  /** The composer's toolbar: Attach, the Agent, Model and Thinking selectors, Send (KOBE-418). */
  get toolbar(): Locator {
    return this.page.locator("[data-composer-toolbar]");
  }

  /** The latest answer's Compact now icon, beside its thumbs down (KOBE-418). */
  get compactNow(): Locator {
    return this.answers.last().getByRole("button", { name: "Compact now", exact: true });
  }

  /**
   * The composer's Model and Thinking selectors: in the toolbar, or in its folded "Agent and
   * model" menu on a narrow composer (opened here when it is closed).
   */
  async selectors(): Promise<Locator> {
    const folded = this.toolbar.getByRole("button", { name: "Agent and model", exact: true });
    if (await folded.isVisible()) {
      if ((await folded.getAttribute("aria-expanded")) !== "true") await folded.click();
      return this.page.getByRole("group", { name: "Agent and model", exact: true });
    }
    return this.toolbar;
  }

  /**
   * Moves every thread this test opened to Trash with the chat's own API call, made from the page
   * so the browser sends the session cookie and the Origin the server's CSRF check wants. A thread
   * whose run (or its title call after the run) has not settled answers 409 `thread_busy`: that
   * one is asked again a moment later, for up to `TRASH_SETTLE_MS`, so no thread is left behind
   * for the next run's specs to find.
   */
  async trashAll(): Promise<void> {
    if (this.seen.length === 0) return;
    const failures = await this.page
      .evaluate(
        async ({ ids, teamKey, teamHeader, settleMs, retryMs }) => {
          const team = window.localStorage.getItem(teamKey);
          const headers: Record<string, string> = team ? { [teamHeader]: team } : {};
          const failed: string[] = [];
          const trash = async (id: string): Promise<string | null> => {
            const deadline = Date.now() + settleMs;
            for (;;) {
              const res = await fetch(`/v1/threads/${encodeURIComponent(id)}`, {
                method: "DELETE",
                headers,
              }).catch(() => null);
              if (res?.ok) return null;
              const code = res
                ? ((await res.json().catch(() => null)) as { code?: string } | null)?.code
                : undefined;
              if (code !== "thread_busy" || Date.now() > deadline) {
                return `${res?.status ?? "network error"}${code ? ` ${code}` : ""}`;
              }
              await new Promise((r) => setTimeout(r, retryMs));
            }
          };
          for (const id of ids) {
            const failure = await trash(id);
            if (failure !== null) failed.push(`${id}: ${failure}`);
          }
          return failed;
        },
        {
          ids: this.seen,
          teamKey: TEAM_KEY,
          teamHeader: TEAM_HEADER,
          settleMs: TRASH_SETTLE_MS,
          retryMs: TRASH_RETRY_MS,
        },
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
