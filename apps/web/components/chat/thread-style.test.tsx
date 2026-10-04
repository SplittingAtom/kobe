// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { chatRequests, composer, openApp } from "./testing";

let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("assistant-ui thread styling", () => {
  it("shows the welcome message and starter suggestions on an empty conversation", async () => {
    openApp(fake);
    expect(await screen.findByText("How can I help you today?")).toBeTruthy();
    expect(screen.getByText(/works in your own isolated workspace/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Analyse a spreadsheet/ })).toBeTruthy();
  });

  it("a suggestion fills the composer without sending anything", async () => {
    openApp(fake);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Write a script/ }));
    expect((await composer()).value).toMatch(/^Write a Python script/);
    expect(chatRequests(fake, "POST")).toHaveLength(0);
  });

  it("hides the welcome and suggestions once the conversation has messages", async () => {
    const t = fake.addThread("Sales");
    const u1 = fake.addEntry(t, null, { role: "user", content: "q1" });
    fake.addEntry(t, u1, { role: "assistant", content: [{ type: "text", text: "a1" }] });
    openApp(fake, t);
    expect(await screen.findByText("a1")).toBeTruthy();
    expect(screen.queryByText("How can I help you today?")).toBeNull();
    expect(screen.queryByRole("button", { name: /Analyse a spreadsheet/ })).toBeNull();
  });

  it("renders message actions as icon buttons that keep their accessible names", async () => {
    const t = fake.addThread("Sales");
    const u1 = fake.addEntry(t, null, { role: "user", content: "q1" });
    const a1 = fake.addEntry(t, u1, {
      role: "assistant",
      content: [{ type: "text", text: "a1" }],
    });
    fake.addEntry(t, a1, { role: "user", content: "q2" });
    openApp(fake, t);
    await screen.findByText("a1");
    const answer = screen.getByText("a1").closest('[data-role="assistant"]') as HTMLElement;
    for (const name of ["Copy", "Regenerate"]) {
      const button = within(answer).getByRole("button", { name });
      expect(button.getAttribute("data-variant")).toBe("ghost");
      expect(button.querySelector("svg")).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Send" }).querySelector("svg")).toBeTruthy();
  });

  it("renders icon-button tooltips inside the chat shell so they get the shadcn tokens", async () => {
    const t = fake.addThread("Sales");
    const u1 = fake.addEntry(t, null, { role: "user", content: "q1" });
    const a1 = fake.addEntry(t, u1, {
      role: "assistant",
      content: [{ type: "text", text: "a1" }],
    });
    fake.addEntry(t, a1, { role: "user", content: "q2" });
    openApp(fake, t);
    await screen.findByText("a1");
    const answer = screen.getByText("a1").closest('[data-role="assistant"]') as HTMLElement;
    const user = userEvent.setup();
    await user.hover(within(answer).getByRole("button", { name: "Copy" }));
    const tip = await waitFor(() => {
      const el = document.querySelector('[data-slot="tooltip-content"]');
      if (!el) throw new Error("tooltip not shown");
      return el;
    });
    expect(tip.closest("[data-kobe-chat]")).toBeTruthy();
  });
});
