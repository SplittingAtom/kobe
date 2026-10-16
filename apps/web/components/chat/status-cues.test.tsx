// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KobeEventPayload } from "@kobe/protocol";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { stubApi } from "../admin/testing";
import { IconActionProvider } from "../shell/icon-action";
import { NotificationBell } from "./notification-bell";
import { STOP_TINT } from "./steering-panel";
import { OUTCOME_TONE } from "./tool-call";
import { composer, openApp, streaming } from "./testing";

/**
 * KOBE-301: the status cues read the status colours of app/theme.css. happy-dom has no cascade,
 * so these pin the tone each cue carries (its class and data attributes) and that its label or
 * icon stays; the token values and their contrast are checked in app/theme-css.test.ts.
 */
// A variable path: Vite rewrites `new URL("literal", import.meta.url)` into a served asset URL.
const cssFile = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

let fake: FakeKobe;
let scrolled: Element[];

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The header's badge (the only StatusBadge in the chat). */
const badge = async () => Promise.resolve(document.querySelector("header [data-status-badge]"));

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

async function running(title = "Work") {
  const t = fake.addThread(title);
  openApp(fake, t);
  await userEvent.setup().type(await composer(), "go{Enter}");
  await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
  const runId = must(fake.activeRun(t)).run_id;
  await streaming(fake, runId);
  return { t, runId };
}

describe("thread header badge (ac-1)", () => {
  it("Running is green with a pulsing dot; the label stays", async () => {
    await running();
    await waitFor(async () =>
      expect((await badge())?.getAttribute("data-status-badge")).toBe("running"),
    );
    const b = must(await badge());
    expect(b.textContent).toBe("Running");
    expect(b.className).toMatch(/running/);
    const dot = must(b.querySelector("[data-status-dot]"));
    expect(dot.getAttribute("data-pulse")).toBe("true");
    expect(dot.getAttribute("aria-hidden")).toBe("true");
  });

  it("Interrupted is amber, without motion", async () => {
    const { runId } = await running();
    fake.agent.loseSandbox(runId);
    await waitFor(async () => expect((await badge())?.textContent).toBe("Interrupted"));
    const b = must(await badge());
    expect(b.getAttribute("data-status-badge")).toBe("attention");
    expect(b.querySelector("[data-pulse]")).toBeNull();
  });

  it("In Trash stays grey, with no dot", async () => {
    const t = fake.addThread("Old");
    must(fake.threads.get(t)).deleted_at = "2026-10-16T10:00:00.000Z";
    openApp(fake, t);
    await waitFor(async () => expect((await badge())?.textContent).toBe("In Trash"));
    const b = must(await badge());
    expect(b.getAttribute("data-status-badge")).toBe("idle");
    expect(b.querySelector("[data-status-dot]")).toBeNull();
  });
});

describe("approval card (ac-3)", () => {
  it("has the amber accent and icon, scrolls into view, and the note waits above the composer until decided", async () => {
    const { runId } = await running();
    fake.agent.toolCall(runId, "tc1", "bash", { command: "rm -rf build" }, "m1");
    fake.requestApproval(runId, asked());
    const card = await screen.findByRole("group", { name: /Approval needed/ });
    expect(card.getAttribute("data-kobe-approval")).toBe("pending");
    const icon = must(card.querySelector("svg[aria-hidden]"));
    expect(icon.getAttribute("class")).toMatch(/attention/);
    expect(scrolled).toContain(card);

    const footer = must(document.querySelector<HTMLElement>("[data-kobe-composer]"));
    const note = await within(footer).findByText("Waiting for your approval");
    expect(footer.contains(note)).toBe(true);
    // Amber with a clock icon; the words stay.
    const cue = must(note.closest("[data-kobe-approval-note]"));
    expect(cue.className).toMatch(/attention/);
    expect(cue.querySelector("svg[aria-hidden]")).not.toBeNull();
    // Show brings the card back when the member scrolled away.
    scrolled = [];
    await userEvent.setup().click(within(footer).getByRole("button", { name: "Show" }));
    expect(scrolled).toEqual([card]);

    await userEvent.setup().click(within(card).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(within(footer).queryByText("Waiting for your approval")).toBeNull());
  });

  it("the accent border is the amber status colour", () => {
    const css = cssFile("./chat.module.css").replace(/\s+/g, " ");
    expect(css).toMatch(
      /\.approval \{[^}]*border-inline-start: 4px solid var\(--kobe-status-attention\)/,
    );
  });
});

describe("tool steps (ac-4)", () => {
  const step = async (outcome: string) =>
    must(
      await waitFor(() => must(document.querySelector(`[data-kobe-outcome-label="${outcome}"]`))),
    );

  it("Running… green and spinning (not under reduced motion), Waiting amber, Done a muted green check", async () => {
    const { runId } = await running();
    fake.agent.toolCall(runId, "tc1", "bash", { command: "ls" }, "m1");
    const run = await step("running");
    expect(run.textContent).toBe("Running…");
    expect(run.className).toMatch(/running/);
    const spinner = must(document.querySelector('[data-kobe-outcome="running"]'));
    expect(spinner.getAttribute("class")).toContain("animate-spin");
    expect(spinner.getAttribute("class")).toContain("motion-reduce:animate-none");

    fake.requestApproval(runId, asked());
    expect((await step("waiting")).className).toMatch(/attention/);

    fake.agent.toolResult(runId, "tc1", "bash", "ok");
    const done = await step("done");
    expect(done.textContent).toBe("Done");
    expect(done.className).toMatch(/done/);
    expect(document.querySelector('[data-kobe-outcome="done"]')?.getAttribute("class")).toMatch(
      /done/,
    );
  });

  it("Failed and Denied are red", async () => {
    const { runId } = await running();
    fake.agent.toolCall(runId, "tc1", "bash", { command: "false" }, "m1");
    fake.agent.toolResult(runId, "tc1", "bash", "exit 1", true);
    const failed = await step("error");
    expect(failed.textContent).toBe("Failed");
    expect(failed.className).toMatch(/failed/);
    expect(OUTCOME_TONE).toEqual({
      denied: "failed",
      error: "failed",
      done: "done",
      waiting: "attention",
      running: "running",
    });
  });
});

describe("smaller cues (ac-6)", () => {
  it("the Stop button is red-tinted while a run streams, and keeps its name", async () => {
    await running();
    const stop = await screen.findByRole("button", { name: /^Stop/ });
    expect(stop.hasAttribute("data-kobe-stop")).toBe(true);
    for (const c of ["border-status-failed", "bg-status-failed-bg", "text-status-failed"]) {
      expect(stop.getAttribute("class")).toContain(c);
      expect(STOP_TINT).toContain(c);
    }
  });

  it("the bell's unread count is an accent pill", async () => {
    stubApi({
      "GET /v1/notifications?unread=true&limit=1": [
        200,
        { notifications: [], unread_count: 3, next_cursor: null },
      ],
    });
    render(
      <IconActionProvider>
        <NotificationBell teamId="t-1" onOpenThread={() => {}} />
      </IconActionProvider>,
    );
    const count = await screen.findByText("3");
    expect(count.className).toMatch(/count/);
    const css = cssFile("../shell/icon-action.module.css").replace(/\s+/g, " ");
    expect(css).toMatch(/\.count \{[^}]*color: var\(--kobe-status-accent-fg\)/);
    expect(css).toMatch(/\.count \{[^}]*background: var\(--kobe-status-accent\)/);
  });

  it("the context gauge's amber and red are the status colours", () => {
    const css = cssFile("../shell/context-gauge.module.css");
    expect(css).toContain("--gauge-warn: var(--kobe-gauge-warn)");
    expect(css).toContain("--gauge-full: var(--kobe-gauge-full)");
  });
});
