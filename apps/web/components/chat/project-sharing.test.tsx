// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { announcement, chatRequests, openApp } from "./testing";

const PROJECT = "00000000-0000-4000-8000-0000000000a1";
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

function projectThread(
  over: { readOnly?: boolean; visibility?: "private" | "project"; project?: string | null } = {},
) {
  const id = fake.addThread("Quarterly plan");
  const thread = must(fake.threads.get(id));
  thread.project_id = over.project === undefined ? PROJECT : over.project;
  if (over.visibility) thread.visibility = over.visibility;
  if (over.readOnly !== undefined) thread.read_only = over.readOnly;
  fake.addEntry(id, null, { role: "user", content: "hello from the owner" });
  return id;
}

describe("share toggle (KOBE-164, ac-2)", () => {
  it("lets the owner share a project thread and make it private again", async () => {
    const id = projectThread({ readOnly: false });
    openApp(fake, id);
    const user = userEvent.setup();
    const toggle = (await screen.findByRole("checkbox", {
      name: "Share with the project",
    })) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByText(/Only you can see this conversation/)).toBeTruthy();
    await user.click(toggle);
    await waitFor(() => expect(fake.threads.get(id)?.visibility).toBe("project"));
    expect(chatRequests(fake, "POST").at(-1)).toMatchObject({
      path: `/v1/threads/${id}/share`,
      body: { visibility: "project" },
      team: fake.teamId,
    });
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(announcement()).toMatch(/Shared with the project/);
    await user.click(toggle);
    await waitFor(() => expect(fake.threads.get(id)?.visibility).toBe("private"));
    expect(chatRequests(fake, "POST").at(-1)?.body).toEqual({ visibility: "private" });
  });

  it("offers no toggle on a thread outside any project", async () => {
    const id = projectThread({ readOnly: false, project: null });
    openApp(fake, id);
    await screen.findByText("hello from the owner");
    expect(screen.queryByRole("checkbox", { name: "Share with the project" })).toBeNull();
  });

  it("shows the server's refusal when sharing fails", async () => {
    const id = projectThread({ readOnly: false });
    fake.failNext.set(
      `POST /v1/threads/${id}/share`,
      new Response(
        JSON.stringify({ code: "project_not_found", message: "That project is gone." }),
        {
          status: 404,
        },
      ),
    );
    openApp(fake, id);
    await userEvent
      .setup()
      .click(await screen.findByRole("checkbox", { name: "Share with the project" }));
    expect(await screen.findByText("That project is gone.")).toBeTruthy();
    expect(fake.threads.get(id)?.visibility).toBeUndefined();
  });
});

describe("read-only shared thread (KOBE-164, ac-2)", () => {
  it("shows the banner, disables mutating controls and no share toggle", async () => {
    const id = projectThread({ readOnly: true, visibility: "project" });
    openApp(fake, id);
    expect(await screen.findByRole("note", { name: "Shared thread" })).toBeTruthy();
    expect(screen.getByText(/shared with you read-only/)).toBeTruthy();
    expect(screen.queryByLabelText("Message")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Share with the project" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByText("hello from the owner")).toBeTruthy();
  });

  it("forks into a private thread of the reader and opens it", async () => {
    const id = projectThread({ readOnly: true, visibility: "project" });
    openApp(fake, id);
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Fork into my conversations" }));
    await waitFor(() => expect(fake.threads.size).toBe(2));
    const fork = must([...fake.threads.keys()].find((k) => k !== id));
    expect(chatRequests(fake, "POST").find((r) => r.path.endsWith("/fork"))?.path).toBe(
      `/v1/threads/${id}/fork`,
    );
    await waitFor(() => expect(window.location.search).toBe(`?thread=${fork}`));
    // The fork is the reader's own: no read-only banner, a composer.
    expect(await screen.findByLabelText("Message")).toBeTruthy();
    expect(screen.queryByRole("note", { name: "Shared thread" })).toBeNull();
  });

  it("renders titles as plain text, never HTML", async () => {
    const id = projectThread({ readOnly: true, visibility: "project" });
    must(fake.threads.get(id)).title = '<img src=x onerror="alert(1)">';
    openApp(fake, id);
    await screen.findByRole("note", { name: "Shared thread" });
    expect(document.querySelector("img[src='x']")).toBeNull();
  });
});

describe("new conversation in a project (KOBE-164)", () => {
  it("creates the thread inside the project from /?project=", async () => {
    openApp(fake, undefined, undefined, `?project=${PROJECT}`);
    expect(await screen.findByText(/will be in the project/)).toBeTruthy();
    await userEvent
      .setup()
      .type(await screen.findByLabelText("Message"), "Plan the quarter{Enter}");
    await waitFor(() => expect(fake.threads.size).toBe(1));
    const created = chatRequests(fake, "POST").find((r) => r.path === "/v1/threads");
    expect(created?.body).toMatchObject({ project_id: PROJECT });
    expect([...fake.threads.values()][0]?.project_id).toBe(PROJECT);
  });
});
