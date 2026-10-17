// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { must } from "../../../lib/testing/must";
import { RowMenu, type RowMenuItem } from "./row-menu";

/**
 * KOBE-306: a dense table's row actions behind one ⋯ button with an accessible name, on the menu
 * button pattern, portalled into the console root.
 */
afterEach(cleanup);

function renderMenu(items: readonly RowMenuItem[], busy = false) {
  return render(
    <div data-kobe-console="">
      <RowMenu label="Actions for Triage" items={items} busy={busy} />
    </div>,
  );
}

const button = () => screen.getByRole("button", { name: "Actions for Triage" });

describe("RowMenu (KOBE-306)", () => {
  it("is a named menu button: opens from the keyboard, lists the items, Escape returns focus", async () => {
    renderMenu([
      { id: "export", label: "Export to Orbit", onSelect: vi.fn() },
      { id: "status", label: "Suspend", destructive: true, onSelect: vi.fn() },
    ]);
    const user = userEvent.setup();
    const trigger = button();
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // The icon is decorative; the name comes from the label.
    expect(trigger.textContent).toBe("");

    trigger.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Export to Orbit", "Suspend"]);
    expect(must(items[1]).className).toContain("text-console-danger");
    // Portalled into the console root, so it takes the console's tokens and rules.
    expect(menu.closest("[data-kobe-console]")).not.toBeNull();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("runs the chosen item after the menu closes, with the focused ⋯ button as the trigger", async () => {
    const onSelect = vi.fn<(trigger: HTMLElement | null) => void>(() => {
      // The menu is gone and focus is back on the button by the time the action runs, so a
      // confirm dialog it opens returns focus there.
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(button());
    });
    renderMenu([{ id: "status", label: "Suspend", onSelect }]);
    const user = userEvent.setup();
    await user.click(button());
    await user.click(await screen.findByRole("menuitem", { name: "Suspend" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledOnce());
    expect(onSelect.mock.calls[0]?.[0]).toBe(button());
  });

  it("does not run a disabled item", async () => {
    const onSelect = vi.fn();
    renderMenu([{ id: "export", label: "Export to Orbit", disabled: true, onSelect }]);
    const user = userEvent.setup();
    await user.click(button());
    const item = await screen.findByRole("menuitem", { name: "Export to Orbit" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    await user.click(item);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows a busy button while an action runs, and renders nothing without items", () => {
    renderMenu([{ id: "export", label: "Export to Orbit", onSelect: vi.fn() }], true);
    expect(button().getAttribute("aria-busy")).toBe("true");
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    const { container } = renderMenu([]);
    expect(container.querySelector("button")).toBeNull();
  });
});
