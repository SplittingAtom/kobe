// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MenuBindings } from "../../lib/shell/menu";
import { IconActionProvider } from "../shell/icon-action";
import { ActionMenu } from "./action-menu";

/**
 * KOBE-292 (ac-4): one menu for the rail's rows, on the menu button pattern: the ⋯ button opens a
 * menu of the registry's commands the row binds; arrow keys move, Escape closes and gives the
 * button its focus back. It portals into the chat root (KOBE-281/282).
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderMenu(bindings: MenuBindings) {
  return render(
    <div data-kobe-chat>
      <IconActionProvider>
        <ActionMenu
          trigger="thread-row-actions"
          label="Actions for Budget"
          scope="thread-menu"
          bindings={bindings}
        />
      </IconActionProvider>
    </div>,
  );
}

const button = () => screen.getByRole("button", { name: "Actions for Budget" });

describe("ActionMenu (KOBE-292)", () => {
  it("is a menu button: opens from the keyboard, arrows move, Escape returns focus", async () => {
    const copy = vi.fn();
    const trash = vi.fn();
    renderMenu({
      "copy-thread": { onSelect: copy },
      "regenerate-thread": { onSelect: vi.fn() },
      "trash-thread": { onSelect: trash, destructive: true },
    });
    const user = userEvent.setup();
    const trigger = button();
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    trigger.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu", { name: "Actions for Budget" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Copy", "Regenerate", "Delete"]);
    // Portalled into the chat root, marked as the chat's own portal.
    expect(menu.closest("[data-kobe-chat]")).not.toBeNull();
    expect(menu.closest("[data-kobe-portal]")).not.toBeNull();

    expect(document.activeElement?.textContent).toBe("Copy");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("Regenerate");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("Delete");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(copy).not.toHaveBeenCalled();

    await user.click(button());
    await user.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Delete" }),
    );
    expect(trash).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps an unavailable item focusable, says why, and does nothing on select", async () => {
    const regenerate = vi.fn();
    renderMenu({
      "copy-thread": { onSelect: vi.fn() },
      "regenerate-thread": { onSelect: regenerate, blocker: "Wait for the current run to finish." },
    });
    const user = userEvent.setup();
    await user.click(button());
    const item = within(await screen.findByRole("menu")).getByRole("menuitem", {
      name: "Regenerate",
    });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("title")).toBe("Wait for the current run to finish.");
    const described = item.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(described)?.textContent).toBe(
      "Wait for the current run to finish.",
    );
    // Opened by pointer: the first arrow press focuses the first item.
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(item);
    await user.keyboard("{Enter}");
    expect(regenerate).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("opens a submenu with the arrow key, the current choice marked", async () => {
    const glm = vi.fn();
    renderMenu({
      "regenerate-thread-with": {
        choices: [
          { key: "", label: "Team default (Kimi)", current: true, onSelect: vi.fn() },
          { key: "glm", label: "GLM 5.3", onSelect: glm },
        ],
      },
    });
    const user = userEvent.setup();
    button().focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu", { name: "Actions for Budget" });
    expect(document.activeElement?.textContent).toBe("Regenerate with");
    expect(document.activeElement?.getAttribute("aria-haspopup")).toBe("menu");
    await user.keyboard("{ArrowRight}");
    const sub = await screen.findByRole("menu", { name: "Regenerate with" });
    expect(sub.closest("[data-kobe-chat]")).not.toBeNull();
    expect(
      within(sub)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Team default (Kimi) (current)", "GLM 5.3"]);
    await user.click(within(sub).getByRole("menuitem", { name: "GLM 5.3" }));
    expect(glm).toHaveBeenCalledOnce();
  });

  it("an unavailable submenu is a plain item with its reason", async () => {
    renderMenu({
      "regenerate-thread-with": {
        blocker: "Wait for the current run to finish.",
        choices: [{ key: "glm", label: "GLM 5.3", onSelect: vi.fn() }],
      },
    });
    const user = userEvent.setup();
    await user.click(button());
    const item = within(await screen.findByRole("menu")).getByRole("menuitem", {
      name: "Regenerate with",
    });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("aria-haspopup")).toBeNull();
  });
});
