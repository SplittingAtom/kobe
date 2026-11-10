// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { openApp } from "../chat/testing";
import { NOT_ALLOWED_NOTES, STALE_NOTE } from "./proposal-inline-review";

/**
 * KOBE-592 (projects spec PE4, PE5): the proposal card for a project file names the project,
 * Review shows the diff against the head with an editable commit message, Accept commits through
 * the server (committed, stale, not allowed); new files in a project and in My files render and
 * accept; shared readers never see Accept.
 */
let fake: FakeKobe;
let projectId = "";
const enc = (s: string) => new TextEncoder().encode(s);
const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";
const HEAD = "alpha\nbeta\n";
const PROPOSED = "alpha\nBETA\n";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
  projectId = fake.addProject("Budget");
  fake.projectHeads.set(projectId, { seq: 3, files: new Map([["plan.md", HEAD]]) });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A reloaded thread whose history holds one recorded proposal (tool call `pe1`). */
function threadWith(proposal: Record<string, unknown>) {
  const thread = fake.addThread("Plan");
  const u = fake.addEntry(thread, null, { role: "user", content: "Tidy" });
  const call = fake.addEntry(thread, u, {
    role: "assistant",
    content: [{ type: "toolCall", id: "pe1", name: "propose_file_edit", arguments: {} }],
  });
  const res = fake.addEntry(thread, call, {
    role: "toolResult",
    toolCallId: "pe1",
    toolName: "propose_file_edit",
    content: [{ type: "text", text: '{"ok":true,"status":"awaiting_user"}' }],
    isError: false,
  });
  fake.addEntry(thread, res, { role: "assistant", content: [{ type: "text", text: "Done." }] });
  fake.fileEditProposals.set(thread, [
    {
      tool_call_id: "pe1",
      content: PROPOSED,
      summary: "Capitalise beta",
      run_id: "00000000-0000-4000-8000-000000000001",
      created_at: "2026-10-21T00:00:00.000Z",
      ...proposal,
    },
  ]);
  return thread;
}

const projectEdit = () => ({
  path: "projects/budget/plan.md",
  proposal_id: PROPOSAL_ID,
  project_id: projectId,
  base_commit_seq: 3,
  base_sha256: "a".repeat(64),
});

async function review(name: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name }));
  return user;
}

describe("a proposed edit to a project file (ac-1, ac-2)", () => {
  it("names the project, diffs against the head and commits with the edited message", async () => {
    const thread = threadWith(projectEdit());
    openApp(fake, thread);
    expect(await screen.findByText(/Proposed edit to/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/plan\.md in Budget/)).toBeTruthy());
    const user = await review("Review the proposed edit to plan.md");
    const diff = await screen.findByRole("region", { name: "Proposed changes to plan.md" });
    const rows = [...diff.querySelectorAll("[data-diff]")].map(
      (r) => `${r.getAttribute("data-diff")}:${r.textContent}`,
    );
    expect(rows).toEqual(["same:  alpha", "removed:- beta", "added:+ BETA"]);
    const message = screen.getByLabelText("Commit message") as HTMLInputElement;
    expect(message.value).toBe("Capitalise beta");
    await user.clear(message);
    await user.type(message, "Fix the casing");
    await user.click(screen.getByRole("button", { name: "Accept" }));
    expect(await screen.findByText(/Committed as #4/)).toBeTruthy();
    expect(fake.fromProposalRequests).toEqual([
      { thread_id: thread, proposal_id: PROPOSAL_ID, message: "Fix the casing" },
    ]);
    const link = screen.getByRole("link", { name: "Open History" });
    expect(link.getAttribute("href")).toBe(`/me/projects/${projectId}#history`);
    expect(screen.getByText("Committed")).toBeTruthy();
  });

  it("says so when the file changed after the proposal", async () => {
    fake.nextFromProposal = {
      status: 409,
      body: { code: "proposal_stale", message: "x", head_seq: 5 },
    };
    openApp(fake, threadWith(projectEdit()));
    const user = await review("Review the proposed edit to plan.md");
    await user.click(await screen.findByRole("button", { name: "Accept" }));
    expect((await screen.findByRole("alert")).textContent).toBe(STALE_NOTE);
  });

  it.each(Object.keys(NOT_ALLOWED_NOTES))("explains not allowed: %s", async (reason) => {
    fake.nextFromProposal = {
      status: 409,
      body: { code: "proposal_not_allowed", message: "x", reason },
    };
    openApp(fake, threadWith(projectEdit()));
    const user = await review("Review the proposed edit to plan.md");
    await user.click(await screen.findByRole("button", { name: "Accept" }));
    expect((await screen.findByRole("alert")).textContent).toBe(NOT_ALLOWED_NOTES[reason]);
  });

  it("Reject writes nothing and shows Discarded", async () => {
    openApp(fake, threadWith(projectEdit()));
    const user = await review("Review the proposed edit to plan.md");
    await user.click(await screen.findByRole("button", { name: "Reject" }));
    expect(await screen.findByText("Discarded")).toBeTruthy();
    expect(fake.fromProposalRequests).toEqual([]);
  });

  it("a shared reader sees no Review and no Accept", async () => {
    const thread = threadWith(projectEdit());
    Object.assign(must(fake.threads.get(thread)), { read_only: true, owner_name: "Alice" });
    openApp(fake, thread);
    expect(await screen.findByText(/Proposed edit to/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Review the proposed/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });
});

describe("a proposed new file (ac-3)", () => {
  it("in a project: all added, accepted through the commit route", async () => {
    const thread = threadWith({
      path: "projects/budget/notes/new.md",
      proposal_id: PROPOSAL_ID,
      project_id: projectId,
      base_commit_seq: 3,
      content: "one\ntwo\n",
    });
    openApp(fake, thread);
    expect(await screen.findByText("Proposed new file")).toBeTruthy();
    const user = await review("Review the proposed edit to new.md");
    const diff = await screen.findByRole("region", { name: "Proposed changes to new.md" });
    const rows = [...diff.querySelectorAll("[data-diff]")].map((r) => r.getAttribute("data-diff"));
    expect(rows).toEqual(["added", "added"]);
    await user.click(screen.getByRole("button", { name: "Accept" }));
    expect(await screen.findByText(/Committed as #4/)).toBeTruthy();
  });

  it("in My files: accepting creates the file without a base, no commit", async () => {
    const thread = threadWith({ path: "notes/todo.txt", content: "buy milk\n" });
    openApp(fake, thread);
    expect(await screen.findByText("Proposed new file")).toBeTruthy();
    const user = await review("Review the proposed edit to todo.txt");
    const section = await screen.findByRole("region", { name: "Proposed changes to todo.txt" });
    expect(within(section).getByText(/buy milk/)).toBeTruthy();
    expect(screen.queryByLabelText("Commit message")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Accept" }));
    expect(await screen.findByText(/Saved todo\.txt/)).toBeTruthy();
    expect(fake.workspaceSaves).toEqual([{ path: "notes/todo.txt", base: "", text: "buy milk\n" }]);
    expect(fake.fromProposalRequests).toEqual([]);
  });

  it("in My files: a file that now exists is refused in plain words", async () => {
    fake.workspaceFiles.set("notes/todo.txt", enc("mine"));
    openApp(fake, threadWith({ path: "notes/todo.txt", content: "buy milk\n" }));
    const user = await review("Review the proposed edit to todo.txt");
    await user.click(await screen.findByRole("button", { name: "Accept" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/now exists/);
  });
});
