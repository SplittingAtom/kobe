// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KobeEventPayload } from "@kobe/protocol";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { ChatApp } from "./chat-app";
import { composer, streaming } from "./testing";

/**
 * KOBE-301 ac-2 and ac-5: the rail shows a pulsing green dot on a thread whose run is going and an
 * amber dot (with its words for screen readers) on one whose approval waits, live, also while
 * another thread is open; the hidden tab's title says the same.
 */
// A variable path: Vite rewrites `new URL("literal", import.meta.url)` into a served asset URL.
const cssFile = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

let fake: FakeKobe;
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  document.title = "Kobe";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function open(threadId: string) {
  window.history.replaceState(null, "", `/?thread=${threadId}`);
  let n = 0;
  return render(
    <ChatApp
      fetchFn={fake.fetch}
      eventSource={fake.eventSource}
      newKey={() => `key-${++n}`}
      reopenDelayMs={() => 0}
      activityPollMs={30}
    />,
  );
}

const rail = () => screen.findByRole("list", { name: "Your threads" });

/** The rail row (its `<li>`) of a thread, by title. */
async function row(title: string): Promise<HTMLElement> {
  const button = await within(await rail()).findByRole("button", { name: new RegExp(`^${title}`) });
  return must(button.closest("li"));
}

const activityOf = async (title: string) =>
  must((await row(title)).querySelector("[data-kobe-activity]")).getAttribute("data-kobe-activity");

function asked(): KobeEventPayload<"approval.requested"> {
  return {
    approval_id: "00000000-0000-4000-8000-000900000001",
    tool_call_id: "tc1",
    tool: "bash",
    input: { command: "rm -rf build" },
    risk: "write",
    reasons: [{ code: "risk_write", stage: "risk_class", message: "Changes files." }],
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

/** Sends a message on the open thread and waits for its run to stream. */
async function startRun(threadId: string): Promise<string> {
  await userEvent.setup().type(await composer(), "go{Enter}");
  await waitFor(() => expect(fake.activeRun(threadId)).toBeDefined());
  const runId = must(fake.activeRun(threadId)).run_id;
  await streaming(fake, runId);
  return runId;
}

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("rail activity dots (ac-2)", () => {
  it("the open thread's run shows a pulsing green dot at once, labelled for screen readers", async () => {
    const t = fake.addThread("Report");
    fake.addThread("Other");
    open(t);
    expect(await activityOf("Report")).toBe("idle");
    await startRun(t);
    await waitFor(async () => expect(await activityOf("Report")).toBe("running"));
    const dot = must((await row("Report")).querySelector("[data-status-dot]"));
    expect(dot.getAttribute("data-status-dot")).toBe("running");
    expect(dot.getAttribute("data-pulse")).toBe("true");
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    // The state is the row button's description (its name stays the title): never colour alone.
    expect(
      within(await rail()).getByRole("button", { name: "Report", description: "Running" }),
    ).toBeTruthy();
    expect(await activityOf("Other")).toBe("idle");
  });

  it("follows a thread while another is open: running, waiting for approval, then idle", async () => {
    const a = fake.addThread("Deploy");
    const b = fake.addThread("Notes");
    open(a);
    const runId = await startRun(a);
    // Open another thread: the run keeps going on the server, the rail keeps showing it.
    await userEvent
      .setup()
      .click(await within(await rail()).findByRole("button", { name: /^Notes/ }));
    await waitFor(() => expect(window.location.search).toBe(`?thread=${b}`));
    await waitFor(async () => expect(await activityOf("Deploy")).toBe("running"));

    fake.agent.toolCall(runId, "tc1", "bash", { command: "rm -rf build" }, "m1");
    fake.requestApproval(runId, asked());
    await waitFor(async () => expect(await activityOf("Deploy")).toBe("approval"));
    const dot = must((await row("Deploy")).querySelector("[data-status-dot]"));
    expect(dot.getAttribute("data-status-dot")).toBe("attention");
    expect(dot.getAttribute("data-pulse")).toBeNull();
    expect(
      within(await rail()).getByRole("button", {
        name: "Deploy",
        description: "Waiting for your approval",
      }),
    ).toBeTruthy();

    fake.agent.complete(runId);
    await waitFor(async () => expect(await activityOf("Deploy")).toBe("idle"));
    expect((await row("Deploy")).querySelector("[data-status-dot]")).toBeNull();
  });

  it("an approval in the open thread turns its dot amber live", async () => {
    const t = fake.addThread("Ops");
    open(t);
    const runId = await startRun(t);
    fake.agent.toolCall(runId, "tc1", "bash", { command: "ls" }, "m1");
    fake.requestApproval(runId, asked());
    await waitFor(async () => expect(await activityOf("Ops")).toBe("approval"));
  });

  it("stops reading the list once nothing outside the open thread is active", async () => {
    const t = fake.addThread("Quiet");
    open(t);
    await rail();
    const lists = () => fake.requests.filter((r) => r.method === "GET" && r.path === "/v1/threads");
    await waitFor(() => expect(lists().length).toBeGreaterThan(0));
    const before = lists().length;
    await new Promise((r) => setTimeout(r, 150));
    expect(lists().length).toBe(before);
  });
});

describe("tab title (ac-5)", () => {
  it("is prefixed only while the tab is hidden, and restored on show, focus or when the state ends", async () => {
    const t = fake.addThread("Build");
    open(t);
    const runId = await startRun(t);
    await waitFor(async () => expect(await activityOf("Build")).toBe("running"));
    expect(document.title).toBe("Kobe"); // a visible tab: no prefix

    setVisibility("hidden");
    expect(document.title).toBe("● Kobe");
    setVisibility("visible");
    expect(document.title).toBe("Kobe");

    setVisibility("hidden");
    fake.agent.toolCall(runId, "tc1", "bash", { command: "ls" }, "m1");
    fake.requestApproval(runId, asked());
    await waitFor(() => expect(document.title).toBe("(!) Kobe"));
    window.dispatchEvent(new Event("focus"));
    expect(document.title).toBe("(!) Kobe"); // still hidden: focus alone does not show the tab
    visibility = "visible";
    window.dispatchEvent(new Event("focus"));
    expect(document.title).toBe("Kobe");

    setVisibility("hidden");
    expect(document.title).toBe("(!) Kobe");
    fake.agent.complete(runId);
    await waitFor(() => expect(document.title).toBe("Kobe")); // the state ended
  });

  it("leaves the title alone when the app goes away", async () => {
    const t = fake.addThread("Gone");
    const view = open(t);
    await startRun(t);
    setVisibility("hidden");
    await waitFor(() => expect(document.title).toBe("● Kobe"));
    view.unmount();
    expect(document.title).toBe("Kobe");
  });
});

describe("reduced motion", () => {
  it("stops the pulse under prefers-reduced-motion", () => {
    const css = cssFile("../ui/status.module.css");
    const reduced = must(css.split("@media (prefers-reduced-motion: reduce)")[1]);
    expect(reduced.replace(/\s+/g, " ")).toContain(".pulse { animation: none; }");
    expect(css).toMatch(/\.pulse \{\s*animation: kobe-status-pulse/);
  });
});
