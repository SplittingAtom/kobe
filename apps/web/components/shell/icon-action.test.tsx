// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMANDS, commandsIn, formatShortcut } from "../../lib/shell/commands";
import { IconAction, TOOLTIP_DELAY_MS } from "./icon-action";

/** KOBE-203 (CE13): one icon component for navigation and actions, named by its tooltip. */
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const tooltip = () => document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');

describe("IconAction", () => {
  it("names the action in its accessible label and renders the registry icon", () => {
    render(<IconAction command="copy" />);
    const button = screen.getByRole("button", { name: "Copy" });
    expect(button.getAttribute("data-command")).toBe("copy");
    expect(button.querySelector("svg")).toBeTruthy();
    expect(button.textContent).toBe("");
  });

  it("opens the tooltip after 300 ms with the same name and the shortcut", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<IconAction command="new-thread" shortcut="Mod+N" />);
    const button = screen.getByRole("button", { name: "New conversation" });
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Control+N Meta+N");
    await user.hover(button);
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 50));
    expect(tooltip()).toBeNull();
    act(() => vi.advanceTimersByTime(100));
    const tip = await waitFor(() => {
      const el = tooltip();
      if (!el) throw new Error("tooltip not shown");
      return el;
    });
    expect(tip.textContent).toContain("New conversation");
    expect(tip.querySelector("kbd")?.textContent).toMatch(/^(Ctrl\+N|⌘N)$/);
  });

  it("shows no shortcut the keyboard doesn't bind yet (C7 turns them on)", () => {
    render(<IconAction command="files" />);
    expect(screen.getByRole("button", { name: "Files" }).hasAttribute("aria-keyshortcuts")).toBe(
      false,
    );
  });

  it("lets the call site name the object, and renders navigation as a link", () => {
    render(
      <>
        <IconAction command="rename-thread" label="Rename Budget" />
        <IconAction command="my-memory" />
        <IconAction command="artifact-download" href="/v1/a/1" download label="Download v1" />
      </>,
    );
    expect(screen.getByRole("button", { name: "Rename Budget" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "My memory" }).getAttribute("href")).toBe("/me/memory");
    const file = screen.getByRole("link", { name: "Download v1" });
    expect(file.hasAttribute("download")).toBe(true);
  });

  it("marks something new with a dot that joins the accessible label", () => {
    const { rerender } = render(<IconAction command="notifications" />);
    expect(document.querySelector("[data-badge]")).toBeNull();
    rerender(<IconAction command="notifications" badge="2 unread" />);
    const bell = screen.getByRole("button", { name: "Notifications, 2 unread" });
    expect(bell.querySelector("[data-badge]")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("describes an unavailable action and passes button props through", async () => {
    const onClick = vi.fn();
    render(
      <IconAction
        command="edit"
        aria-disabled="true"
        description="Coming soon"
        onClick={onClick}
      />,
    );
    const button = screen.getByRole("button", { name: "Edit" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const described = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("Coming soon");
    await userEvent.setup().click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("command registry", () => {
  it("has unique ids and names every command", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of COMMANDS) expect(c.name.trim()).not.toBe("");
  });

  it("records the CE23 shortcuts", () => {
    const shortcuts = Object.fromEntries(
      COMMANDS.filter((c) => c.shortcut).map((c) => [c.id, c.shortcut]),
    );
    expect(shortcuts).toEqual({
      files: "Mod+Shift+F",
      "new-thread": "Mod+N",
      "toggle-rail": "Mod+B",
      edit: "Mod+Shift+E",
    });
    expect(formatShortcut("Mod+Shift+F", true)).toBe("⌘⇧F");
    expect(formatShortcut("Mod+Shift+F", false)).toBe("Ctrl+Shift+F");
  });

  it("offers the consoles only where the server opens them", () => {
    const bar = (consoles: ("site" | "team")[]) => commandsIn("bar", { consoles }).map((c) => c.id);
    expect(bar([])).not.toContain("team-console");
    expect(bar(["team"])).toContain("team-console");
    expect(bar(["team"])).not.toContain("site-console");
    expect(bar(["site", "team"])).toContain("site-console");
  });
});
