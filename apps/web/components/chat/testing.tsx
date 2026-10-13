import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
