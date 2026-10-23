// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestReload, resetReloadRequest } from "../../lib/build/reload-draft";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { composer, openApp } from "./testing";

/**
 * KOBE-487 ac-4: the new-build banner's Reload keeps the composer's draft: the composer stashes it
 * as the page unloads and takes it back after the reload, for the same thread only.
 */
let fake: FakeKobe;
const WAIT = { timeout: 10_000 };

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  resetReloadRequest();
  vi.unstubAllGlobals();
});

function thread(title: string) {
  const t = fake.addThread(title);
  const u = fake.addEntry(t, null, { role: "user", content: "Hi" });
  fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: `In ${title}.` }] });
  return t;
}

async function typeDraft(text: string) {
  const input = await composer();
  await userEvent.setup().type(input, text);
  await waitFor(() => expect(input.value).toBe(text));
}

describe("the composer's draft across the banner's Reload (KOBE-487)", { timeout: 30_000 }, () => {
  it("comes back on the same thread after the reload", async () => {
    const t = thread("One");
    openApp(fake, t);
    await screen.findByText("In One.", undefined, WAIT);
    await typeDraft("half a thought");
    requestReload();
    window.dispatchEvent(new Event("pagehide"));
    cleanup();
    resetReloadRequest();

    openApp(fake, t);
    await screen.findByText("In One.", undefined, WAIT);
    await waitFor(
      () =>
        expect(
          (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value,
        ).toBe("half a thought"),
      WAIT,
    );
  });

  it("is not kept when the page unloads without the banner's Reload", async () => {
    const t = thread("Two");
    openApp(fake, t);
    await screen.findByText("In Two.", undefined, WAIT);
    await typeDraft("gone");
    window.dispatchEvent(new Event("pagehide"));
    expect(sessionStorage.getItem("kobe.reload-drafts")).toBeNull();
  });
});
