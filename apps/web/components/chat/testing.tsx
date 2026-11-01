import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  type MatcherFunction,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";
import type { UploadTransport } from "../../lib/chat/uploads";
import type { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { isMacPlatform } from "../../lib/shell/shortcuts";
import { ChatApp } from "./chat-app";

/** Renders the chat app over the fake server, optionally on a thread (`?thread=`). */
export function openApp(
  fake: FakeKobe,
  threadId?: string,
  uploadTransport?: UploadTransport,
  search = "",
) {
  window.history.replaceState(null, "", threadId ? `/?thread=${threadId}` : `/${search}`);
  let n = 0;
  return render(
    <ChatApp
      fetchFn={fake.fetch}
      eventSource={fake.eventSource}
      newKey={() => `key-${++n}`}
      reopenDelayMs={() => 0}
      uploadTransport={uploadTransport}
    />,
  );
}

/** Opens a rail row's ⋯ menu (KOBE-292) by its button's name; returns the menu, named alike. */
export async function openRowMenu(name: string): Promise<HTMLElement> {
  // Thread rows are in the Threads panel since KOBE-453: opened first when none is on screen.
  if (screen.queryByRole("button", { name }) === null && !/\.[a-z0-9]+$/i.test(name)) {
    await openThreads();
  }
  await userEvent.setup().click(await screen.findByRole("button", { name }));
  return screen.findByRole("menu", { name });
}

export function chatRequests(fake: FakeKobe, method?: string) {
  return fake.requests.filter(
    (r) =>
      (r.path.startsWith("/v1/threads") || r.path.startsWith("/v1/runs")) &&
      (method === undefined || r.method === method),
  );
}

/** Waits until the browser holds exactly one stream, for `runId` if given. */
export async function streaming(fake: FakeKobe, runId?: string) {
  await waitFor(() => {
    expect(fake.openStreams.map((s) => s.runId)).toEqual(runId ? [runId] : [expect.any(String)]);
    expect(fake.openStreams[0]?.readyState).toBe(1);
  });
}

export async function composer() {
  await closeThreads();
  return (await screen.findByLabelText("Message")) as HTMLTextAreaElement;
}

/** Closes the Threads panel (KOBE-453) if it is open, as its Close button does. */
export async function closeThreads(): Promise<void> {
  const panel = screen.queryByRole("dialog", { name: "Threads" });
  if (panel === null) return;
  fireEvent.click(within(panel).getByRole("button", { name: "Close Threads" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Threads" })).toBeNull());
}

/** The status line screen readers hear (the thread's polite live region, not the phase one). */
export function announcement(): string {
  const live = document.querySelector('[aria-live="polite"]:not([data-kobe-phase-live])');
  return (live?.textContent ?? "").replace(/\u00a0/g, "");
}

/**
 * A press of `Mod`+Shift+`key` on the page (Cmd on macOS, Ctrl elsewhere): the CE23 chords whose
 * on-screen buttons left the bar in KOBE-418 (Mod+Shift+F shows the files, Mod+Shift+D every
 * detail).
 */
export function pressModShift(key: string, target: Element = document.body): boolean {
  return fireEvent.keyDown(target, {
    key,
    code: `Key${key.toUpperCase()}`,
    shiftKey: true,
    ...(isMacPlatform() ? { metaKey: true } : { ctrlKey: true }),
  });
}

/** The agent radios (KOBE-122), in the composer's popover since KOBE-418: opened when closed. */
export async function agentChoices(): Promise<HTMLElement> {
  const open = screen.queryByRole("radiogroup", { name: "Chat with" });
  if (open) return open;
  fireEvent.click(await screen.findByRole("button", { name: /^Chat with:/ }));
  return screen.findByRole("radiogroup", { name: "Chat with" });
}

/**
 * Matches the innermost element holding exactly `text`, also when the text is split across
 * elements: a streaming part's words are separate spans (KOBE-207).
 */
export function streamed(text: string): MatcherFunction {
  const holds = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim() === text;
  return (_content, el) => el !== null && holds(el) && ![...el.children].some(holds);
}

/** Text only screen readers get: Tailwind's `sr-only` and the CSS modules' `visuallyHidden`. */
const VISUALLY_HIDDEN = '.sr-only, [class*="visuallyHidden"], [class*="visually-hidden"]';

/** A class that sets the horizontal padding (`p-0`, `px-1`, `md:p-0`); `py-*` alone does not. */
const INLINE_PADDING = /^(?:[\w-]+:)*!?px?-/;

function visibleText(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll(VISUALLY_HIDDEN)) hidden.remove();
  return (copy.textContent ?? "").trim();
}

/**
 * Icon-only raw buttons in the chat that the base button rule would crush (KOBE-269):
 * `chat-global.css` pads every `button:not([data-slot])` 0.25rem 0.75rem, which leaves a 28 px
 * icon button 2 px for its svg. A button whose visible text is empty (its name comes from
 * `aria-label` or visually hidden text) must be an `IconAction` (shadcn's Button sets `data-slot`)
 * or set its own inline padding. Returns each offender's accessible label; happy-dom has no
 * layout, so this checks attributes and classes, not pixels.
 */
export function crushedIconButtons(root: ParentNode = document): string[] {
  return [...root.querySelectorAll("[data-kobe-chat] button:not([data-slot])")]
    .filter((b) => b.querySelector("svg, img") !== null && visibleText(b) === "")
    .filter((b) => ![...b.classList].some((c) => INLINE_PADDING.test(c)))
    .map(
      (b) => b.getAttribute("aria-label") ?? (b.textContent?.trim() || b.outerHTML.slice(0, 120)),
    );
}

/**
 * Lists and paragraphs under `root` that keep the browser's spacing (KOBE-269): the chat has no
 * Tailwind preflight, so Kobe chrome resets its own (`m-0`; lists also `list-none ps-0`), while
 * message Markdown and notices keep theirs. Returns the offenders' tag names and text.
 */
export function browserSpaced(root: ParentNode): string[] {
  const has = (el: Element, ...names: string[]) => names.every((n) => el.classList.contains(n));
  return [...root.querySelectorAll("p, ul, ol")]
    .filter((el) => !el.classList.contains("sr-only"))
    .filter((el) => (el.tagName === "P" ? !has(el, "m-0") : !has(el, "m-0", "list-none", "ps-0")))
    .map((el) => `${el.tagName.toLowerCase()}: ${(el.textContent ?? "").trim().slice(0, 40)}`);
}

/**
 * Opens the Threads panel over the workspace (KOBE-453) at its address, as the rail's Threads
 * button does, and returns it (or the one already open). Choosing a thread in it closes it.
 */
export async function openThreads(): Promise<HTMLElement> {
  const open = screen.queryByRole("dialog", { name: "Threads" });
  if (open) return open;
  // The workspace first (its thread on screen), as a member clicks Threads in a loaded rail.
  await screen.findByLabelText("Message", undefined, { timeout: 5_000 });
  act(() => {
    window.history.pushState(null, "", "/threads");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  return screen.findByRole("dialog", { name: "Threads" }, { timeout: 5_000 });
}

/** A group's list of thread rows in the Threads panel (KOBE-453), opening the panel first. */
export async function threadGroup(name: string): Promise<HTMLElement> {
  await openThreads();
  return screen.findByRole("list", { name }, { timeout: 5_000 });
}

/**
 * Chooses a node of the Threads panel's folder tree (KOBE-536), opening the panel first and
 * Current's chevron for Archived; returns the panel.
 */
export async function chooseNode(name: string): Promise<HTMLElement> {
  const panel = await openThreads();
  const tree = within(panel);
  if (name === "Archived" && tree.queryByRole("treeitem", { name: "Archived" }) === null) {
    const current = await tree.findByRole("treeitem", { name: "Current" }, { timeout: 5_000 });
    fireEvent.click(current.querySelector("button") as HTMLElement);
  }
  fireEvent.click(await tree.findByRole("treeitem", { name }, { timeout: 5_000 }));
  await waitFor(() =>
    expect(tree.getByRole("treeitem", { name }).getAttribute("aria-selected")).toBe("true"),
  );
  return panel;
}
