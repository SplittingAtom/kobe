// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { announcement, chatRequests, composer, openApp, streaming } from "./testing";

/**
 * KOBE-420 (D19, U8): a thread pinned to an older version of its agent says "v<N> available" in
 * its header, with a one-click Switch that uses the switch API; the next run's prompt then shows
 * the switch marker. A reader of a shared thread sees the badge without Switch; a thread on the
 * current version shows nothing.
 */
let fake: FakeKobe;
const AGENT = "aaaaaaaa-0000-4000-8000-000000000001";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function pinned(pinnedTo: number, current: number | null, extra: object = {}) {
  const t = fake.addThread("Forecast");
  Object.assign(must(fake.threads.get(t)), {
    agent_id: AGENT,
    agent_name: "Analyst",
    agent_status: "active",
    agent_version: pinnedTo,
    agent_current_version: current,
    ...extra,
  });
  return t;
}

const header = async () =>
  must((await screen.findByRole("heading", { level: 2, name: "Forecast" })).closest("header"));
const offer = () => document.querySelector<HTMLElement>("[data-kobe-agent-version]");
const switches = () => chatRequests(fake, "POST").filter((r) => r.path.endsWith("/agent-version"));

describe("the v<N> available badge (KOBE-420 ac-1)", () => {
  it("shows in the header with an accessible name naming both versions", async () => {
    openApp(fake, pinned(1, 3));
    const head = await header();
    const group = await within(head).findByRole("group", {
      name: "Analyst v3 available. This thread uses v1.",
    });
    expect(group.textContent).toContain("v3 available");
    expect(within(group).getByRole("button", { name: "Switch this thread to v3" })).toBeTruthy();
  });

  it("is not shown on the current version, without an agent, or before the thread is read", async () => {
    openApp(fake, pinned(3, 3));
    await header();
    expect(offer()).toBeNull();
    cleanup();
    const plain = fake.addThread("Forecast");
    openApp(fake, plain);
    await header();
    expect(offer()).toBeNull();
  });
});

describe("one-click Switch (KOBE-420 ac-2)", () => {
  it("switches through the API to the shown version; the badge goes and the change is announced", async () => {
    const t = pinned(1, 3);
    openApp(fake, t);
    const user = userEvent.setup();
    await user.click(
      await within(await header()).findByRole("button", { name: "Switch this thread to v3" }),
    );
    await waitFor(() => expect(offer()).toBeNull());
    expect(switches()).toEqual([
      expect.objectContaining({ path: `/v1/threads/${t}/agent-version`, body: { version: 3 } }),
    ]);
    expect(fake.threads.get(t)?.agent_version).toBe(3);
    expect(announcement()).toBe("Switched to v3. Your next message uses it.");
    // The button went with the offer: focus goes to the composer, not to the page.
    await waitFor(async () => expect(document.activeElement).toBe(await composer()));
  });

  it("sends one request for a double click", async () => {
    const t = pinned(1, 3);
    openApp(fake, t);
    const button = await within(await header()).findByRole("button", {
      name: "Switch this thread to v3",
    });
    await userEvent.setup().dblClick(button);
    await waitFor(() => expect(offer()).toBeNull());
    expect(switches()).toHaveLength(1);
  });

  it("offers a version published meanwhile once switched", async () => {
    const t = pinned(1, 3);
    openApp(fake, t);
    const button = await within(await header()).findByRole("button", {
      name: "Switch this thread to v3",
    });
    must(fake.threads.get(t)).agent_current_version = 4;
    await userEvent.setup().click(button);
    expect(
      await within(await header()).findByRole("button", { name: "Switch this thread to v4" }),
    ).toBeTruthy();
  });

  it("shows the server's refusal and keeps the offer", async () => {
    const t = pinned(1, 3);
    fake.failNext.set(
      `POST /v1/threads/${t}/agent-version`,
      Response.json(
        { code: "agent_suspended", message: "This agent is suspended." },
        { status: 409 },
      ),
    );
    openApp(fake, t);
    const user = userEvent.setup();
    await user.click(
      await within(await header()).findByRole("button", { name: "Switch this thread to v3" }),
    );
    expect(await screen.findByText(/This agent is suspended\./)).toBeTruthy();
    expect(offer()).not.toBeNull();
    expect(fake.threads.get(t)?.agent_version).toBe(1);
  });

  it("waits while a run is active (the server would refuse it)", async () => {
    const t = pinned(1, 3);
    openApp(fake, t);
    await userEvent.setup().type(await composer(), "go{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    await streaming(fake, must(fake.activeRun(t)).run_id);
    const button = await within(await header()).findByRole("button", {
      name: "Switch this thread to v3",
    });
    // Still focusable, with the reason as its description; a click sends nothing.
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBe("true"));
    expect(button.hasAttribute("disabled")).toBe(false);
    const described = must(document.getElementById(must(button.getAttribute("aria-describedby"))));
    expect(described.textContent).toBe("Switch when the run ends.");
    await userEvent.setup().click(button);
    expect(switches()).toEqual([]);
  });

  it("marks the switch above the prompt of the run that used the new version", async () => {
    const t = pinned(3, 3);
    const u1 = fake.addEntry(t, null, { role: "user", content: "Q3?" });
    const a1 = fake.addEntry(t, u1, {
      role: "assistant",
      content: [{ type: "text", text: "Up." }],
    });
    const u2 = fake.addEntry(t, a1, { role: "user", content: "Q4?" });
    fake.addEntry(t, u2, { role: "assistant", content: [{ type: "text", text: "Flat." }] });
    fake.threadMarkers.set(t, {
      runs: [],
      approvals: [],
      agents: [
        {
          run_id: "run-2",
          user_entry_id: u2,
          parent_entry_id: a1,
          from_version: 1,
          to_version: 3,
        },
      ],
    });
    openApp(fake, t);
    const row = await waitFor(() =>
      must(document.querySelector<HTMLElement>('[data-kobe-marker="agent"]')),
    );
    expect(row.textContent?.replace(/\s+/g, " ").trim()).toBe("Switched to v3 · from v1");
    // Above the second prompt: after the first answer, before "Q4?".
    const text = document.body.textContent ?? "";
    expect(text.indexOf("Up.")).toBeLessThan(text.indexOf("Switched to v3"));
    expect(text.indexOf("Switched to v3")).toBeLessThan(text.indexOf("Q4?"));
  });
});

describe("when Switch is not offered (KOBE-420 ac-3)", () => {
  it.each(["suspended", "archived"] as const)(
    "a %s agent shows the badge without Switch",
    async (status) => {
      openApp(fake, pinned(1, 3, { agent_status: status }));
      const group = await within(await header()).findByRole("group", {
        name: "Analyst v3 available. This thread uses v1.",
      });
      expect(within(group).queryByRole("button")).toBeNull();
    },
  );

  it("a thread in Trash shows no offer", async () => {
    openApp(fake, pinned(1, 3, { deleted_at: "2026-10-17T10:00:00.000Z" }));
    await header();
    expect(offer()).toBeNull();
  });
});

describe("read-only shared threads (KOBE-420 ac-3)", () => {
  it("show the badge without Switch", async () => {
    openApp(fake, pinned(1, 3, { read_only: true, visibility: "team", owner_name: "Ann" }));
    const group = await within(await header()).findByRole("group", {
      name: "Analyst v3 available. This thread uses v1.",
    });
    expect(within(group).queryByRole("button")).toBeNull();
  });
});
