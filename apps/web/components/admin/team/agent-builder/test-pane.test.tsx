// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../../../lib/chat/testing/fake-kobe";
import { must } from "../../../../lib/testing/must";
import { TEAM, ME, renderTeam, stubApi } from "../../testing";
import { AgentBuilderPage } from "./agent-builder-page";
import { AgentTestPane } from "./test-pane";

const AGENT = "11111111-1111-4111-8111-111111111111";
const DRAFT = {
  id: AGENT,
  scope: "team",
  slug: "helper",
  name: "Helper",
  status: "active",
  ownerUserId: ME.id,
  currentVersion: null,
  revision: 1,
  updatedAt: "2026-10-01T10:00:00Z",
  canEdit: true,
  canPublish: true,
  canExport: true,
  starters: [],
  frontmatter: { name: "Helper" },
  prompt: "Help.",
};
const READ = {
  "GET /v1/team/models": [200, { models: [], default: null }],
  [`GET /v1/agents/${AGENT}`]: [200, { agent: DRAFT }],
  [`GET /v1/agents/${AGENT}/versions`]: [
    200,
    { current_version: null, versions: [], next_before: null },
  ],
} as const;

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function openPane(fake: FakeKobe) {
  let n = 0;
  return render(
    <AgentTestPane
      teamId={fake.teamId}
      agentId={AGENT}
      fetchFn={fake.fetch}
      eventSource={fake.eventSource}
      newKey={() => `key-${++n}`}
      reopenDelayMs={() => 0}
    />,
  );
}

describe("builder test pane (KOBE-85)", () => {
  it("ac-1: the first message creates a test thread on the agent's draft", async () => {
    const fake = new FakeKobe();
    openPane(fake);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Message"), "Hello draft{Enter}");
    await waitFor(() => expect(fake.threads.size).toBe(1));
    const create = must(fake.requests.find((r) => r.method === "POST" && r.path === "/v1/threads"));
    expect(create.body).toMatchObject({ agent_id: AGENT, test: true });
    const [thread] = [...fake.threads.values()];
    expect(thread?.is_test).toBe(true);
    // Nothing from the pane touches the thread list or Trash.
    expect(fake.requests.some((r) => r.path.startsWith("/v1/threads?"))).toBe(false);
    expect(fake.requests.some((r) => r.path.startsWith("/v1/threads/trash"))).toBe(false);
  });

  it("clears the test threads of this agent and starts a fresh conversation", async () => {
    const fake = new FakeKobe();
    openPane(fake);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Message"), "one{Enter}");
    await waitFor(() => expect(fake.threads.size).toBe(1));
    await user.click(screen.getByRole("button", { name: "Clear test chats" }));
    await waitFor(() =>
      expect(
        fake.requests.some(
          (r) => r.method === "DELETE" && r.path === `/v1/threads/test?agent_id=${AGENT}`,
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect([...fake.threads.values()].every((t) => t.deleted_at !== null)).toBe(true),
    );
    // A fresh composer, no messages from the cleared conversation.
    expect(((await screen.findByLabelText("Message")) as HTMLTextAreaElement).value).toBe("");
  });
});

describe("the builder page offers the test chat", () => {
  it("for a saved agent (team and personal), not for a new one", async () => {
    stubApi({ "GET /v1/team/models": [200, { models: [], default: null }] });
    renderTeam(<AgentBuilderPage />);
    await screen.findByLabelText("Name");
    expect(screen.queryByRole("button", { name: "Test chat" })).toBeNull();
    cleanup();

    for (const scope of ["team", "personal"] as const) {
      stubApi(READ);
      renderTeam(<AgentBuilderPage agentId={AGENT} scope={scope} />, {
        role: "member",
        permissions: ["team.read"],
      });
      const open = await screen.findByRole("button", { name: "Test chat" });
      expect(screen.getByText(/unpublished draft/i)).toBeTruthy();
      await userEvent.click(open);
      expect(await screen.findByLabelText("Message")).toBeTruthy();
      cleanup();
    }
    expect(TEAM.id).toBeTruthy();
  });

  it("not for an agent the caller can't edit", async () => {
    stubApi({
      ...READ,
      [`GET /v1/agents/${AGENT}`]: [200, { agent: { ...DRAFT, canEdit: false } }],
    });
    renderTeam(<AgentBuilderPage agentId={AGENT} />);
    await screen.findByLabelText("Name");
    expect(screen.queryByRole("button", { name: "Test chat" })).toBeNull();
  });
});
