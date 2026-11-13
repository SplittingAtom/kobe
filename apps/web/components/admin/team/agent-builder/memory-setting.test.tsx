// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentVersion, setTeamAgentMemory } from "../../../../lib/admin/api/team/agent-builder";
import { stubApi } from "../../testing";
import { MemorySetting } from "./memory-setting";

/** KOBE-646 ac-2: the agent editor shows the version's memory setting and saves a change. */
const AGENT = "11111111-1111-4111-8111-111111111111";
const VERSION = (n: number, memory?: string) => ({
  version: n,
  publishedBy: null,
  publishedAt: "2026-11-13T00:00:00.000Z",
  draftRevision: 1,
  republishedFrom: null,
  frontmatter: { name: "A" },
  prompt: "p",
  ...(memory === undefined ? {} : { memory }),
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (props: Partial<{ currentVersion: number | null; canChange: boolean }> = {}) => {
  const onChanged = vi.fn();
  render(
    <MemorySetting
      agentId={AGENT}
      api={{
        readVersion: (v) => getAgentVersion("t-1", AGENT, v),
        save: (memory) => setTeamAgentMemory("t-1", AGENT, memory),
      }}
      currentVersion={2}
      canChange
      busy={false}
      onChanged={onChanged}
      {...props}
    />,
  );
  return onChanged;
};

const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;

describe("MemorySetting", () => {
  it("shows the current version's setting and saves a change as a new version", async () => {
    const published = { agent: { id: AGENT, currentVersion: 3 }, version: VERSION(3, "off") };
    const calls = stubApi({
      [`GET /v1/agents/${AGENT}/versions/2`]: [200, { version: VERSION(2, "notes_only") }],
      [`POST /v1/agents/${AGENT}/memory`]: [201, published],
    });
    const onChanged = show();
    await waitFor(() => expect(radio("Notes only").checked).toBe(true));
    const save = screen.getByRole("button", { name: "Save as a new version" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(radio("Off"));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(published, "off"));
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(post?.body))).toEqual({ memory: "off" });
  });

  it("reads a version from an older server as all, read-only without publish rights", async () => {
    stubApi({ [`GET /v1/agents/${AGENT}/versions/2`]: [200, { version: VERSION(2) }] });
    show({ canChange: false });
    await waitFor(() => expect(radio("All memory").checked).toBe(true));
    expect(radio("Off").disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save as a new version" })).toBeNull();
  });

  it("asks for a publish first on an agent that was never published", () => {
    stubApi({});
    show({ currentVersion: null });
    expect(screen.getByText(/Publish the agent to choose its memory/)).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
  });
});
