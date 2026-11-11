// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorToolbar, ModeSwitch, type ToolbarAction } from "./editor-toolbar";
import type { TextMode } from "./text-modes";

/** KOBE-615 ac-2: the file editor's one toolbar, its Rendered/Raw switch and its More menu. */
afterEach(cleanup);

function Harness({ actions }: { readonly actions: readonly ToolbarAction[] }) {
  const [mode, setMode] = useState<TextMode>("rendered");
  return (
    <div data-kobe-chat>
      <EditorToolbar
        label="notes.md view"
        leading={<ModeSwitch mode={mode} onMode={setMode} />}
        actions={actions}
        status={<span>Kernel idle</span>}
      />
      <p>{`mode: ${mode}`}</p>
    </div>
  );
}

describe("the editor toolbar (ac-2)", () => {
  it("the Rendered/Raw switch is a keyboard-operable switch", async () => {
    render(<Harness actions={[]} />);
    const user = userEvent.setup();
    const toggle = screen.getByRole("switch", { name: "Raw" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("mode: raw")).toBeTruthy();
    toggle.focus();
    await user.keyboard(" ");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await user.keyboard("{Enter}");
    expect(screen.getByText("mode: raw")).toBeTruthy();
  });

  it("holds every action in one row; a disabled one says why", async () => {
    const save = vi.fn();
    render(
      <Harness
        actions={[
          { id: "save", label: "Save", onSelect: save },
          {
            id: "run",
            label: "Run",
            onSelect: vi.fn(),
            disabled: true,
            reason: "Send a message first.",
          },
        ]}
      />,
    );
    const toolbar = screen.getByRole("toolbar", { name: "notes.md view" });
    await userEvent.setup().click(within(toolbar).getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledOnce();
    const run = within(toolbar).getByRole("button", { name: "Run" });
    expect(run.hasAttribute("disabled")).toBe(true);
    expect(run.getAttribute("title")).toBe("Send a message first.");
    expect(within(toolbar).getByText("Kernel idle")).toBeTruthy();
    // Nothing folds: no More menu.
    expect(within(toolbar).queryByRole("button", { name: "More file actions" })).toBeNull();
  });

  it("folding actions hide at narrow widths and are listed in the More menu", async () => {
    const saveAs = vi.fn();
    render(
      <Harness
        actions={[
          { id: "save", label: "Save", onSelect: vi.fn() },
          { id: "save-as", label: "Save As", onSelect: saveAs, overflow: true },
          { id: "add", label: "Add code cell", onSelect: vi.fn(), overflow: true, disabled: true },
        ]}
      />,
    );
    const toolbar = screen.getByRole("toolbar", { name: "notes.md view" });
    // The row's copy only shows on a wide toolbar (container query); Save never folds.
    expect(within(toolbar).getByRole("button", { name: "Save As" }).className).toContain("hidden");
    expect(within(toolbar).getByRole("button", { name: "Save" }).className).not.toContain("hidden");
    const more = within(toolbar).getByRole("button", { name: "More file actions" });
    const user = userEvent.setup();
    await user.click(more);
    const menu = await screen.findByRole("menu");
    expect(
      within(menu).getByRole("menuitem", { name: "Add code cell" }).getAttribute("aria-disabled"),
    ).toBe("true");
    await user.click(within(menu).getByRole("menuitem", { name: "Save As" }));
    expect(saveAs).toHaveBeenCalledOnce();
  });
});
