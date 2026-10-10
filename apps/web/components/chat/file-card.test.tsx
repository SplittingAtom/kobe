// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { composer, openApp, streaming } from "./testing";

let fake: FakeKobe;
const create = vi.fn(() => "blob:x");
const revoke = vi.fn();

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  create.mockClear();
  revoke.mockClear();
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function shareFile(file: Uint8Array, status = 200, extra: Record<string, unknown> = {}) {
  const t = fake.addThread("Reports");
  const u = fake.addEntry(t, null, { role: "user", content: "make it" });
  fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "a" }] });
  openApp(fake, t);
  await screen.findByText("make it");
  const user = userEvent.setup();
  await user.type(await composer(), "share a report{Enter}");
  await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
  const runId = must(fake.activeRun(t)).run_id;
  await streaming(fake, runId);
  const id = fake.addSharedFile(file, status);
  fake.agent.toolCall(runId, "tc1", "share_file", { path: "report.csv" });
  fake.emit(runId, "file.shared", {
    file_id: id,
    tool_call_id: "tc1",
    name: "report.csv",
    size: 2048,
    mime_type: "text/csv",
    ...extra,
  });
  return { user, id };
}

describe("the file.shared download card", () => {
  it("shows name, size and type, and downloads through the files API", async () => {
    const { user, id } = await shareFile(new Uint8Array([1, 2, 3]), 200, {
      description: "Q3 numbers",
    });
    expect(await screen.findByText("report.csv")).toBeTruthy();
    expect(screen.getByText(/2 KB/u)).toBeTruthy();
    expect(screen.getByText(/text\/csv/u)).toBeTruthy();
    expect(screen.getByText("Q3 numbers")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Download report.csv" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const seen = fake.requests.find((r) => r.path === `/v1/files/${id}/content`);
    expect(seen?.method).toBe("GET");
  });

  it("says so when the file is gone or was rejected", async () => {
    const { user } = await shareFile(new Uint8Array(), 404);
    await user.click(await screen.findByRole("button", { name: "Download report.csv" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/no longer available/u);
    expect(create).not.toHaveBeenCalled();
  });

  it("says so when the storage is unavailable", async () => {
    const { user } = await shareFile(new Uint8Array(), 503);
    await user.click(await screen.findByRole("button", { name: "Download report.csv" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/try again/iu);
  });
});
