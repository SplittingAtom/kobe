// @vitest-environment happy-dom
/**
 * KOBE-586 (PF2): Promote to project…'s dialog: the name prefilled with the folder's, the
 * server's refusal shown in the dialog, Escape cancels, and the new project handed back.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "../../lib/api/client";
import type { FileEntry } from "../../lib/files/api";
import type { Project } from "../../lib/projects/api";
import { PromoteDialog } from "./promote-dialog";

afterEach(cleanup);

const folder: FileEntry = {
  name: "q3",
  path: "notes/q3",
  type: "dir",
  sizeBytes: null,
  mtime: "",
  source: "synced",
  area: "workspace",
};
const made = { id: "p-1", name: "Q3 numbers", slug: "q3-numbers" } as Project;

function mount(answer: ApiResult<Project>) {
  const promoteFolder = vi.fn(() => Promise.resolve(answer));
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(
    <PromoteDialog entry={folder} api={{ promoteFolder }} onDone={onDone} onCancel={onCancel} />,
  );
  return { promoteFolder, onDone, onCancel };
}

describe("PromoteDialog (PF2)", () => {
  it("asks for the name only, prefilled with the folder's, and hands back the project", async () => {
    const { promoteFolder, onDone } = mount({ ok: true, status: 201, data: made });
    const dialog = screen.getByRole("dialog", { name: "Promote q3 to a project" });
    const name = screen.getByRole("textbox", { name: "Project name" });
    expect(dialog.querySelectorAll("input")).toHaveLength(1);
    expect((name as HTMLInputElement).value).toBe("q3");
    expect(document.activeElement).toBe(name);
    const user = userEvent.setup();
    await user.clear(name);
    await user.type(name, "Q3 numbers");
    await user.click(screen.getByRole("button", { name: "Promote" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(made));
    expect(promoteFolder).toHaveBeenCalledWith("notes/q3", "Q3 numbers");
  });

  it("shows the server's refusal in the dialog and stays open", async () => {
    const message = "This folder is empty; create the project from Projects instead.";
    const { onDone } = mount({
      ok: false,
      error: { status: 422, code: "invalid_input", message },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Promote" }));
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("refuses an empty name before asking the server; Escape cancels", async () => {
    const { promoteFolder, onCancel } = mount({ ok: true, status: 201, data: made });
    const user = userEvent.setup();
    await user.clear(screen.getByRole("textbox", { name: "Project name" }));
    await user.click(screen.getByRole("button", { name: "Promote" }));
    expect(screen.getByRole("alert").textContent).toBe("Type a name for the project.");
    expect(promoteFolder).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
  });
});
