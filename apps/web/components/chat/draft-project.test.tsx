// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { chatRequests, openApp, openThreads } from "./testing";

/** KOBE-588 (PC-1): the new conversation's header and project control (spec §3 NC1-NC5). */
let fake: FakeKobe;
let alpha: string;
let beta: string;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  alpha = fake.addProject("Alpha");
  beta = fake.addProject("Beta");
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const heading = (name: string) => screen.findByRole("heading", { level: 2, name });
const control = (name: string) => screen.findByRole("button", { name });

describe("new conversation header (NC1)", () => {
  it("names the project, drops the banner, and keeps the privacy sentence for the tooltip", async () => {
    openApp(fake, undefined, undefined, `?project=${alpha}`);
    expect(await heading("New conversation in Alpha")).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText(/will be in the project/)).toBeNull();
    expect(
      (await control("Project for this conversation")).getAttribute("aria-describedby"),
    ).toBeTruthy();
  });

  it("reads New conversation with an Add to a project control when there is no project", async () => {
    openApp(fake);
    expect(await heading("New conversation")).toBeTruthy();
    expect(await control("Add to a project")).toBeTruthy();
  });

  it("has no control on a created conversation", async () => {
    const t = fake.addThread("Budget");
    openApp(fake, t);
    await heading("Budget");
    expect(
      screen.queryByRole("button", { name: /project for this conversation|add to a project/i }),
    ).toBeNull();
  });
});

describe("project control (NC2, NC3)", () => {
  it("adds, switches and removes the project without mounting anything", async () => {
    openApp(fake);
    const user = userEvent.setup();
    await user.click(await control("Add to a project"));
    await user.click(await screen.findByRole("radio", { name: "Alpha" }));
    expect(await heading("New conversation in Alpha")).toBeTruthy();
    await user.click(await control("Project for this conversation"));
    expect((screen.getByRole("radio", { name: "Alpha" }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole("radio", { name: "Beta" }));
    expect(await heading("New conversation in Beta")).toBeTruthy();
    await user.click(await control("Project for this conversation"));
    await user.click(screen.getByRole("button", { name: "Remove project" }));
    expect(await heading("New conversation")).toBeTruthy();
    expect(await control("Add to a project")).toBeTruthy();
    expect(chatRequests(fake, "POST")).toEqual([]);
    expect(chatRequests(fake, "PUT")).toEqual([]);
  });

  it("filters once there are more than eight projects", async () => {
    for (let i = 0; i < 8; i++) fake.addProject(`Extra ${i}`);
    openApp(fake);
    const user = userEvent.setup();
    await user.click(await control("Add to a project"));
    const filter = await screen.findByRole("searchbox", { name: "Filter projects" });
    await user.type(filter, "bet");
    const group = screen.getByRole("radiogroup", { name: "Project for this conversation" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((r) => r.getAttribute("name") && r.parentElement?.textContent),
    ).toEqual(["Beta"]);
  });

  it("has no filter field with eight or fewer", async () => {
    openApp(fake);
    await userEvent.setup().click(await control("Add to a project"));
    await screen.findByRole("radio", { name: "Alpha" });
    expect(screen.queryByRole("searchbox", { name: "Filter projects" })).toBeNull();
  });

  it("creates the conversation in the chosen project on the first send", async () => {
    openApp(fake, undefined, undefined, `?project=${alpha}`);
    const user = userEvent.setup();
    await user.click(await control("Project for this conversation"));
    await user.click(await screen.findByRole("radio", { name: "Beta" }));
    await user.type(await screen.findByLabelText("Message"), "Plan{Enter}");
    await waitFor(() => expect(fake.threads.size).toBe(1));
    expect([...fake.threads.values()][0]?.project_id).toBe(beta);
  });
});

describe("the draft project's life (NC4)", () => {
  it("New conversation clears it", async () => {
    openApp(fake, undefined, undefined, `?project=${alpha}`);
    expect(await heading("New conversation in Alpha")).toBeTruthy();
    await userEvent.setup().click(await screen.findByRole("button", { name: "New conversation" }));
    expect(await heading("New conversation")).toBeTruthy();
    expect(await control("Add to a project")).toBeTruthy();
  });

  it("opening another conversation clears it, and the next new one has none", async () => {
    const t = fake.addThread("Budget");
    openApp(fake, t);
    await heading("Budget");
    // Sticky-draft regression: a project set while another conversation is open must not follow.
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New conversation" }));
    await user.click(await control("Add to a project"));
    await user.click(await screen.findByRole("radio", { name: "Alpha" }));
    expect(await heading("New conversation in Alpha")).toBeTruthy();
    await openThreads();
    await user.click(await screen.findByRole("button", { name: "Budget" }));
    await heading("Budget");
    await user.click(await screen.findByRole("button", { name: "New conversation" }));
    expect(await heading("New conversation")).toBeTruthy();
  });
});

describe("a refused send (NC5)", () => {
  const refuse = (status: number, code: string, message: string) =>
    fake.failNext.set(
      "POST /v1/threads",
      new Response(JSON.stringify({ code, message }), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );

  it("says the project can no longer be used, keeps the header text, offers Remove project", async () => {
    openApp(fake, undefined, undefined, `?project=${alpha}`);
    refuse(404, "project_not_found", "No project with that id is available to you.");
    await userEvent.setup().type(await screen.findByLabelText("Message"), "Hi{Enter}");
    const alert = await screen
      .findByText(/no longer start conversations/)
      .then((n) => n.closest("[role=alert]") as HTMLElement);
    expect(alert.textContent).toContain("You can no longer start conversations in Alpha");
    expect(await heading("New conversation in Alpha")).toBeTruthy();
    const remove = within(alert).getByRole("button", { name: "Remove project" });
    expect(document.activeElement).toBe(remove);
    await userEvent.setup().click(remove);
    expect(await heading("New conversation")).toBeTruthy();
    expect(screen.queryByText(/no longer start/)).toBeNull();
  });

  it("shows the mount limit", async () => {
    openApp(fake, undefined, undefined, `?project=${alpha}`);
    refuse(409, "too_many_mounts", "This workspace can mount at most 2 projects.");
    await userEvent.setup().type(await screen.findByLabelText("Message"), "Hi{Enter}");
    expect(
      await screen.findByText(/at most 2 projects/, { selector: "[role=alert]" }),
    ).toBeTruthy();
  });
});
