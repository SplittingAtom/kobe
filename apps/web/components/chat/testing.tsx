import { fireEvent, render, screen, waitFor, type MatcherFunction } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";
import type { UploadTransport } from "../../lib/chat/uploads";
import type { FakeKobe } from "../../lib/chat/testing/fake-kobe";
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
  return (await screen.findByLabelText("Message")) as HTMLTextAreaElement;
}

/** The status line screen readers hear (the thread's polite live region, not the phase one). */
export function announcement(): string {
  const live = document.querySelector('[aria-live="polite"]:not([data-kobe-phase-live])');
  return (live?.textContent ?? "").replace(/\u00a0/g, "");
}

/** The agent radios (KOBE-122), in bar row two's popover since KOBE-197: opened when closed. */
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
