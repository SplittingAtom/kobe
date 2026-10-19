// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { groupThreads, placementCustom } from "../../lib/chat/thread-groups";
import { must } from "../../lib/testing/must";
import { SkillTestPane } from "./test-pane";

/** The Workbench test pane (KOBE-323): a Kobe-agent chat on this draft alone, as it is now. */
const DRAFT = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function openPane(fake: FakeKobe, flush: () => Promise<unknown>) {
  let n = 0;
  return render(
    <SkillTestPane
      teamId={fake.teamId}
      draftId={DRAFT}
      flush={flush}
      fetchFn={fake.fetch}
      eventSource={fake.eventSource}
      newKey={() => `key-${++n}`}
    />,
  );
}

describe("Workbench test pane", () => {
  it("ac-1: saves pending edits, then starts a test chat of this draft with no agent choice", async () => {
    const fake = new FakeKobe();
    const order: string[] = [];
    const flush = vi.fn(async () => {
      order.push("flush");
      return null;
    });
    const fetch = fake.fetch;
    const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/messages")) order.push("send");
      return fetch(input, init);
    });
    let n = 0;
    render(
      <SkillTestPane
        teamId={fake.teamId}
        draftId={DRAFT}
        flush={flush}
        fetchFn={spy as typeof globalThis.fetch}
        eventSource={fake.eventSource}
        newKey={() => `key-${++n}`}
      />,
    );
    expect(screen.queryByRole("button", { name: /agent/i })).toBeNull();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Message"), "A sales report, please{Enter}");
    await waitFor(() => expect(order).toContain("send"));
    expect(order.slice(0, 2)).toEqual(["flush", "send"]);
    const create = must(fake.requests.find((r) => r.method === "POST" && r.path === "/v1/threads"));
    expect(create.body).toMatchObject({ skill_draft_id: DRAFT });
    expect(create.body).not.toHaveProperty("agent_id");
    expect(create.body).not.toHaveProperty("test");
  });

  it("ac-3: its chats land in the rail's Workbench group", async () => {
    const fake = new FakeKobe();
    openPane(fake, async () => null);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Message"), "Hello{Enter}");
    await waitFor(() => expect(fake.threads.size).toBe(1));
    const listed = await fake.fetch(`/v1/threads`, { headers: { "x-kobe-team": fake.teamId } });
    const body = (await listed.json()) as { threads: Record<string, unknown>[] };
    const thread = must(body.threads[0]);
    expect(thread).toMatchObject({ skill_test: true, skill_draft_id: DRAFT });
    const custom = placementCustom({
      threadId: String(thread.thread_id),
      skillTest: true,
      projectId: null,
    } as Parameters<typeof placementCustom>[0]);
    const groups = groupThreads([{ id: "x", custom }], [], () => undefined);
    expect(groups.map((g) => g.label)).toEqual(["Workbench"]);
  });
});
