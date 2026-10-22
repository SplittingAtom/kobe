// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { openApp } from "./testing";

/**
 * KOBE-485: text artifacts open in the file editor's UI, read-only (Rendered/Raw, version picker,
 * ac-1), and the thread's owner can Edit as file: the server copies the version into artifacts/
 * and the file opens editable in its own tab (ac-2). Shared readers get no button.
 */
let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  const settings = (window as unknown as { happyDOM?: { settings: Record<string, boolean> } })
    .happyDOM?.settings;
  if (settings) {
    settings.disableIframePageLoading = true;
    settings.handleDisabledFileLoadingAsSuccess = true;
  }
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function threadWith(artifact: Parameters<FakeKobe["addArtifact"]>[1]) {
  const t = fake.addThread("Reports");
  const u = fake.addEntry(t, null, { role: "user", content: "make it" });
  fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "done" }] });
  const id = fake.addArtifact(t, artifact);
  return { t, id };
}

async function openFromList(title: string) {
  const user = userEvent.setup();
  const list = await screen.findByRole("navigation", { name: "Artifacts in this conversation" });
  await user.click(within(list).getByRole("button", { name: title }));
  const panel = await screen.findByRole("region", { name: title });
  return { user, panel };
}

async function editorView(label: string): Promise<EditorView> {
  const content = await screen.findByLabelText(label);
  return must(EditorView.findFromDOM(content as HTMLElement));
}

describe("text artifacts in the editor UI (ac-1)", () => {
  it("shows Rendered and a read-only Raw view, with the version picker", async () => {
    const { t } = threadWith({ kind: "markdown", title: "Plan", versions: ["# One", "# Two"] });
    openApp(fake, t);
    const { user, panel } = await openFromList("Plan");
    expect(await within(panel).findByRole("heading", { name: "Two" })).toBeTruthy();
    expect(within(panel).getByText("Version 2 of 2")).toBeTruthy();
    expect(
      within(panel).getByRole("button", { name: "Rendered" }).getAttribute("aria-pressed"),
    ).toBe("true");
    // No Save: an artifact is never edited in place.
    expect(within(panel).queryByRole("button", { name: "Save" })).toBeNull();

    await user.click(within(panel).getByRole("button", { name: "Raw" }));
    const view = await editorView("Plan (version 2, read-only)");
    expect(view.state.doc.toString()).toBe("# Two");
    await waitFor(() => expect(view.state.readOnly).toBe(true));
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");

    // The version picker still steps through versions; Raw stays on.
    await user.click(within(panel).getByRole("button", { name: "Previous version" }));
    await waitFor(async () =>
      expect((await editorView("Plan (version 1, read-only)")).state.doc.toString()).toBe("# One"),
    );
  });

  it("renders csv, code and json with the file editor's renderers", async () => {
    const { t } = threadWith({ kind: "csv", title: "Sales", versions: ["region,total\nEU,1"] });
    fake.addArtifact(t, { kind: "code", title: "Data", language: "json", versions: ['{"a":1}'] });
    openApp(fake, t);
    const { panel } = await openFromList("Sales");
    expect(await within(panel).findByRole("columnheader", { name: "total" })).toBeTruthy();
    const { panel: json } = await openFromList("Data");
    // JSON is pretty-printed, as a workspace .json file is.
    await waitFor(() => expect(json.textContent).toContain('"a": 1'));
  });

  it("keeps html in its frame, without the editor's modes", async () => {
    const { t } = threadWith({ kind: "html", title: "Page", versions: ["<p>hi</p>"] });
    openApp(fake, t);
    const { panel } = await openFromList("Page");
    await waitFor(() => expect(panel.querySelector("iframe")).not.toBeNull());
    expect(within(panel).queryByRole("button", { name: "Raw" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Edit as file" })).toBeNull();
  });
});

describe("Edit as file (ac-2)", () => {
  it("asks the server to copy the shown version, then opens the file editable", async () => {
    const { t, id } = threadWith({
      kind: "markdown",
      title: "Q3 Plan",
      versions: ["# v1", "# v2"],
    });
    fake.workspaceFiles.set("artifacts/q3-plan.md", new TextEncoder().encode("taken"));
    openApp(fake, t);
    const { user, panel } = await openFromList("Q3 Plan");
    await within(panel).findByRole("heading", { name: "v2" });
    await user.click(within(panel).getByRole("button", { name: "Previous version" }));
    await within(panel).findByRole("heading", { name: "v1" });
    await user.click(within(panel).getByRole("button", { name: "Edit as file" }));

    expect(
      fake.requests.filter((r) => r.method === "POST" && r.path.includes("/edit-as-file")),
    ).toMatchObject([{ path: `/v1/artifacts/${id}/versions/1/edit-as-file`, team: fake.teamId }]);
    // A clash never overwrites: the copy is -2, and its tab opens.
    expect(await screen.findByRole("tab", { name: "q3-plan-2.md", selected: true })).toBeTruthy();
    expect(new TextDecoder().decode(fake.workspaceFiles.get("artifacts/q3-plan.md"))).toBe("taken");
    const user2 = userEvent.setup();
    await user2.click(await screen.findByRole("button", { name: "Raw" }));
    const view = await editorView("Edit q3-plan-2.md");
    expect(view.state.doc.toString()).toBe("# v1");
    expect(view.state.readOnly).toBe(false);
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    // The artifact tab is still there, unchanged.
    expect(screen.getByRole("tab", { name: "Q3 Plan" })).toBeTruthy();
  });

  it("shows the server's refusal", async () => {
    const { t, id } = threadWith({ kind: "markdown", title: "Plan", versions: ["# p"] });
    fake.failNext.set(
      `POST /v1/artifacts/${id}/versions/1/edit-as-file`,
      new Response(JSON.stringify({ code: "quota_exceeded", message: "No room." }), {
        status: 507,
        headers: { "content-type": "application/json" },
      }),
    );
    openApp(fake, t);
    const { user, panel } = await openFromList("Plan");
    await within(panel).findByRole("heading", { name: "p" });
    await user.click(within(panel).getByRole("button", { name: "Edit as file" }));
    expect(await within(panel).findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "plan.md" })).toBeNull();
  });

  it("is not offered to a shared reader", async () => {
    const { t } = threadWith({ kind: "markdown", title: "Plan", versions: ["# p"] });
    Object.assign(must(fake.threads.get(t)), { read_only: true, owner_name: "Alice" });
    openApp(fake, t);
    const { panel } = await openFromList("Plan");
    await within(panel).findByRole("heading", { name: "p" });
    expect(within(panel).getByRole("button", { name: "Raw" })).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Edit as file" })).toBeNull();
  });
});
