// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { composer, openApp, streaming } from "./testing";

/** The "Memory updated" chip and its Undo (KOBE-158, ac-1) in the chat over the fake server. */
let fake: FakeKobe;
const DOC = "00000000-0000-4000-8000-0000000d0c01";

beforeEach(() => {
  sessionStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function remembered(extra: Record<string, unknown>, path = "prefs.md") {
  const t = fake.addThread("Notes");
  openApp(fake, t);
  const user = userEvent.setup();
  await user.type(await composer(), "remember this{Enter}");
  await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
  const runId = must(fake.activeRun(t)).run_id;
  await streaming(fake, runId);
  fake.emit(runId, "memory.updated", {
    scope: "user",
    memory_doc_id: DOC,
    path,
    version: 2,
    ...extra,
  });
  await screen.findByText(/Memory updated/);
  return user;
}

const memoryCalls = () => fake.requests.filter((r) => r.path.startsWith("/v1/memory"));

describe("Memory updated chip", () => {
  it("Undo restores the prior version of an edited doc", async () => {
    const user = await remembered({ previous_version: 1 });
    await user.click(screen.getByRole("button", { name: /Undo memory update prefs\.md/ }));
    await screen.findByText("Undone.");
    expect(memoryCalls()).toEqual([
      expect.objectContaining({
        method: "POST",
        path: `/v1/memory/${DOC}/restore`,
        team: fake.teamId,
        body: { version: 1 },
      }),
    ]);
    expect(screen.queryByRole("button", { name: /Undo memory update/ })).toBeNull();
  });

  it("Undo of a write that created the doc deletes it", async () => {
    const user = await remembered({});
    await user.click(screen.getByRole("button", { name: /Undo memory update/ }));
    await screen.findByText("Undone.");
    expect(memoryCalls().map((r) => `${r.method} ${r.path}`)).toEqual([`DELETE /v1/memory/${DOC}`]);
  });

  it("a failed Undo says so and can be tried again", async () => {
    const user = await remembered({ previous_version: 1 });
    fake.failNext.set(
      `POST /v1/memory/${DOC}/restore`,
      new Response(JSON.stringify({ code: "memory_disabled", message: "off" }), { status: 403 }),
    );
    await user.click(screen.getByRole("button", { name: /Undo memory update/ }));
    await screen.findByText(/Memory is turned off for this team/);
    await user.click(screen.getByRole("button", { name: /Undo memory update/ }));
    await screen.findByText("Undone.");
  });

  it("shows the agent's path as plain text with invisible characters escaped", async () => {
    await remembered({ previous_version: 1 }, "a‮b<img src=x>.md");
    const chip = screen.getByText(/Memory updated/);
    expect(chip.textContent).toContain("a\\u202eb<img src=x>.md");
    expect(chip.querySelector("img")).toBeNull();
  });
});
