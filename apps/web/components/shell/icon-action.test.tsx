// @vitest-environment happy-dom
import { act, cleanup, render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Slot } from "radix-ui";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ariaKeyShortcuts, COMMANDS, commandsIn, formatShortcut } from "../../lib/shell/commands";
import { IconAction, IconActionProvider, TOOLTIP_DELAY_MS } from "./icon-action";

/** KOBE-203 (CE13): one icon component for navigation and actions, named by its tooltip. */
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const render = (ui: ReactElement) =>
  rtlRender(ui, { wrapper: ({ children }) => <IconActionProvider>{children}</IconActionProvider> });

const tooltip = () => document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
const shownTooltip = () =>
  waitFor(() => {
    const el = tooltip();
    if (!el) throw new Error("tooltip not shown");
    return el;
  });

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
    const tip = await shownTooltip();
    expect(tip.textContent).toContain("New conversation");
    expect(tip.querySelector("kbd")?.textContent).toMatch(/^(Ctrl\+N|⌘N)$/);
  });

  it("shows the bound CE23 shortcut (KOBE-225), and none where the call site says so", () => {
    render(
      <>
        <IconAction command="files" />
        <IconAction command="detail" shortcut={null} />
        <IconAction command="edit" />
      </>,
    );
    expect(screen.getByRole("button", { name: "Files" }).getAttribute("aria-keyshortcuts")).toBe(
      "Control+Shift+F Meta+Shift+F",
    );
    const detail = screen.getByRole("button", { name: "Show all details" });
    expect(detail.hasAttribute("aria-keyshortcuts")).toBe(false);
    // Edit has no key of its own: the last message's Edit shows edit-last-message's.
    expect(screen.getByRole("button", { name: "Edit" }).hasAttribute("aria-keyshortcuts")).toBe(
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

  it("marks something new with a dot, or a count, that joins the accessible label", () => {
    const { rerender } = render(<IconAction command="notifications" />);
    expect(document.querySelector("[data-badge]")).toBeNull();
    rerender(<IconAction command="notifications" badge="2 unread" />);
    const bell = screen.getByRole("button", { name: "Notifications, 2 unread" });
    expect(bell.querySelector("[data-badge]")?.getAttribute("aria-hidden")).toBe("true");
    expect(bell.querySelector("[data-badge]")?.textContent).toBe("");
    rerender(<IconAction command="notifications" badge="150 unread" count={150} />);
    expect(screen.getByRole("button", { name: "Notifications, 150 unread" }).textContent).toBe(
      "99+",
    );
  });

  it("keeps a disabled action hoverable: tooltip, aria-disabled, click swallowed", async () => {
    const onClick = vi.fn();
    render(<IconAction command="artifact-next" disabled onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Next version" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    const user = userEvent.setup();
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
    await user.hover(button);
    expect((await shownTooltip()).textContent).toContain("Next version");
  });

  it("describes an unavailable action", () => {
    render(<IconAction command="edit" aria-disabled="true" description="Coming soon" />);
    const button = screen.getByRole("button", { name: "Edit" });
    const described = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("Coming soon");
  });

  it("keeps its own label and command over props passed through asChild, merging descriptions", async () => {
    const onClick = vi.fn();
    render(
      <>
        <span id="hint">Hint</span>
        <Slot.Root
          aria-label="Passed label"
          aria-describedby="hint"
          data-command="other"
          onClick={onClick}
        >
          <IconAction command="regenerate" description="Why" />
        </Slot.Root>
      </>,
    );
    const button = screen.getByRole("button", { name: "Regenerate" });
    expect(button.getAttribute("data-command")).toBe("regenerate");
    const ids = (button.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids[0]).toBe("hint");
    expect(ids).toHaveLength(2);
    await userEvent.setup().click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("applies the same rule to links", () => {
    render(
      <Slot.Root aria-label="Passed label" data-command="other">
        <IconAction command="my-agents" />
      </Slot.Root>,
    );
    const link = screen.getByRole("link", { name: "My agents" });
    expect(link.getAttribute("data-command")).toBe("my-agents");
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
      "command-palette": "Mod+K",
      "new-thread": "Mod+N",
      "toggle-rail": "Mod+B",
      files: "Mod+Shift+F",
      "toggle-artifacts": "Mod+Shift+A",
      detail: "Mod+Shift+D",
      stop: "Mod+.",
      steer: "Mod+Shift+Enter",
      "edit-last-message": "Mod+Shift+E",
      "previous-thread": "Mod+[",
      "next-thread": "Mod+]",
      "focus-composer": "Mod+/",
      // The sheet's own key; not one of the twelve.
      "keyboard-shortcuts": "?",
    });
  });

  it.each([
    ["Mod+Shift+F", "⌘⇧F", "Ctrl+Shift+F", "Control+Shift+F Meta+Shift+F"],
    ["Mod+.", "⌘.", "Ctrl+.", "Control+. Meta+."],
    ["Shift+?", "⇧?", "Shift+?", "Shift+?"],
    ["Escape", "Esc", "Esc", "Escape"],
    ["Ctrl+K", "⌃K", "Ctrl+K", "Control+K"],
  ])("writes %s as %s on macOS, %s elsewhere, %s for ARIA", (keys, mac, other, aria) => {
    expect(formatShortcut(keys, true)).toBe(mac);
    expect(formatShortcut(keys, false)).toBe(other);
    expect(ariaKeyShortcuts(keys)).toBe(aria);
  });

  it("offers the consoles only where the server opens them", () => {
    const ids = (scope: "bar" | "rail", consoles: ("site" | "team")[]) =>
      commandsIn(scope, { consoles }).map((c) => c.id);
    // Team console sits on the rail's top line (KOBE-419), Site console in the bar.
    expect(ids("rail", [])).not.toContain("team-console");
    expect(ids("rail", ["team"])).toContain("team-console");
    expect(ids("bar", ["team"])).not.toContain("team-console");
    expect(ids("bar", ["team"])).not.toContain("site-console");
    expect(ids("bar", ["site", "team"])).toContain("site-console");
  });
});
