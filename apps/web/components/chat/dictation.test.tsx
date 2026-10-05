// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { composer, openApp } from "./testing";

/**
 * Composer dictation: the mic button turns speech into prompt text with the browser's speech
 * recognition (Web Speech API). Spoken text is appended to what was already typed; nothing is sent
 * until the user sends. Browsers without speech recognition get no mic button.
 */
class FakeRecognition {
  static last: FakeRecognition | undefined;
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  constructor() {
    FakeRecognition.last = this;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.started = false;
    this.onend?.();
  }
  abort() {
    this.stop();
  }
  /** Delivers the session's results so far, as the browser does on every result event. */
  say(...transcripts: string[]) {
    this.onresult?.({ results: transcripts.map((transcript) => [{ transcript }]) });
  }
}

let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  FakeRecognition.last = undefined;
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const recognition = () => {
  const r = FakeRecognition.last;
  if (!r) throw new Error("speech recognition was not started");
  return r;
};

describe("composer dictation", () => {
  it("appends what the user says to the prompt, live, without sending", async () => {
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    openApp(fake);
    const user = userEvent.setup();
    const input = await composer();
    await user.type(input, "Summarise");

    await user.click(await screen.findByRole("button", { name: "Dictate" }));
    const r = recognition();
    expect(r.started).toBe(true);
    expect(r.continuous).toBe(true);
    expect(r.interimResults).toBe(true);

    r.say("the sales");
    await waitFor(() => expect(input.value).toBe("Summarise the sales"));
    r.say("the sales", " report");
    await waitFor(() => expect(input.value).toBe("Summarise the sales report"));

    await user.click(screen.getByRole("button", { name: "Stop dictation" }));
    expect(r.started).toBe(false);
    expect(screen.getByRole("button", { name: "Dictate" })).toBeTruthy();
    expect(input.value).toBe("Summarise the sales report");
    expect(fake.requests.filter((q) => q.method === "POST")).toEqual([]);
  });

  it("uses the unprefixed SpeechRecognition when the browser has it", async () => {
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    openApp(fake);
    const user = userEvent.setup();
    const input = await composer();
    await user.click(await screen.findByRole("button", { name: "Dictate" }));
    recognition().say("hello");
    await waitFor(() => expect(input.value).toBe("hello"));
  });

  it("says so when the microphone is blocked", async () => {
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    openApp(fake);
    const user = userEvent.setup();
    await composer();
    await user.click(await screen.findByRole("button", { name: "Dictate" }));
    const r = recognition();
    r.onerror?.({ error: "not-allowed" });
    r.stop();
    expect(await screen.findByText(/Microphone access is blocked/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dictate" })).toBeTruthy();
  });

  it("shows no mic button when the browser has no speech recognition", async () => {
    openApp(fake);
    await composer();
    expect(screen.queryByRole("button", { name: "Dictate" })).toBeNull();
  });
});
