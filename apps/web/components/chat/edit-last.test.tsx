// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { composer, openApp, streaming } from "./testing";

/**
 * KOBE-225 (CE23, ac-3): Up arrow in an empty composer, the caret at its start, edits the last
 * sent message, as its Edit button does. It leaves the `/` and `@` menus' arrows alone, and does
 * nothing while a run is on or while an IME composes.
 */
let fake: FakeKobe;
const WAIT = { timeout: 10_000 };

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  fake.teamModels.push({ alias: "kimi", label: "Kimi K2.7 Code", enabled: true, is_default: true });
  fake.workspaceFiles.set("reports/summary.md", new Uint8Array(1));
  vi.stubGlobal("fetch", fake.fetch);
  resizeWindow(DESKTOP_WIDTH);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Two exchanges: the second question is the last sent message. */
function conversation() {
  const t = fake.addThread("Report");
  const first = fake.addSystemEntry(t, null, "model_change", { provider: "kobe", modelId: "kimi" });
  const root = fake.addSystemEntry(t, first, "thinking_level_change", { thinkingLevel: "off" });
  const q1 = fake.addEntry(t, root, { role: "user", content: "First question" });
  const a1 = fake.addEntry(t, q1, { role: "assistant", content: [{ type: "text", text: "One." }] });
  const q2 = fake.addEntry(t, a1, { role: "user", content: "Second question" });
  fake.addEntry(t, q2, { role: "assistant", content: [{ type: "text", text: "Two." }] });
  return t;
}

async function opened(t: string) {
  openApp(fake, t);
  await screen.findByText("Two.", undefined, WAIT);
  await screen.findByRole("combobox", { name: "Model for this conversation" }, WAIT);
  const input = await composer();
  input.focus();
  return input;
}

const editBox = () => screen.queryByLabelText("Edit your message") as HTMLTextAreaElement | null;

describe("Up arrow edits the last sent message (ac-3)", { timeout: 30_000 }, () => {
  it("from an empty composer: the last question opens in its edit box, focused", async () => {
    const input = await opened(conversation());
    await userEvent.setup().keyboard("{ArrowUp}");
    const edit = await screen.findByLabelText("Edit your message");
    expect((edit as HTMLTextAreaElement).value).toBe("Second question");
    await waitFor(() => expect(document.activeElement).toBe(edit));
    expect(input.isConnected).toBe(true);
  });

  it("not when the composer has text, wherever the caret is", async () => {
    const input = await opened(conversation());
    const user = userEvent.setup();
    await user.type(input, "draft");
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    await user.keyboard("{ArrowUp}");
    await new Promise((r) => setTimeout(r, 50));
    expect(editBox()).toBeNull();
    expect(input.value).toBe("draft");
  });

  it("leaves the / menu's arrows alone", async () => {
    const input = await opened(conversation());
    const user = userEvent.setup();
    await user.type(input, "/");
    const list = await screen.findByRole("listbox", { name: "Actions" }, WAIT);
    const options = within(list).getAllByRole("option");
    await user.keyboard("{ArrowDown}{ArrowUp}");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
    expect(editBox()).toBeNull();
  });

  it("leaves the @ menu's arrows alone", async () => {
    const input = await opened(conversation());
    const user = userEvent.setup();
    await user.type(input, "@sum");
    await screen.findByRole("listbox", { name: "Workspace files" }, WAIT);
    await user.keyboard("{ArrowUp}");
    expect(editBox()).toBeNull();
    expect(input.value).toBe("@sum");
  });

  it("not with a modifier, nor while an IME composes", async () => {
    const input = await opened(conversation());
    fireEvent.keyDown(input, { key: "ArrowUp", shiftKey: true });
    fireEvent.keyDown(input, { key: "ArrowUp", altKey: true });
    fireEvent.keyDown(input, { key: "ArrowUp", isComposing: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(editBox()).toBeNull();
  });

  it("not while the agent answers (the Edit button is hidden then too)", async () => {
    const t = conversation();
    const input = await opened(t);
    const user = userEvent.setup();
    await user.type(input, "Third question{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    await streaming(fake, must(fake.activeRun(t)).run_id);
    await waitFor(() => expect(input.value).toBe(""));
    await user.keyboard("{ArrowUp}");
    await new Promise((r) => setTimeout(r, 50));
    expect(editBox()).toBeNull();
  });

  it("not in a new conversation, which has nothing sent yet", async () => {
    openApp(fake);
    const input = await composer();
    input.focus();
    await userEvent.setup().keyboard("{ArrowUp}");
    await new Promise((r) => setTimeout(r, 50));
    expect(editBox()).toBeNull();
  });
});
