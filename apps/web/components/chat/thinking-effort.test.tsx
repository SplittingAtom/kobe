// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThinkingEffort, type EffortLevel } from "./thinking-effort";

/**
 * KOBE-556: assistant-ui's Reasoning effort element, vendored and restyled: one pill per level
 * with aria-pressed and the group's sr-only label. KOBE-574 removed the spend bar and readout.
 */
afterEach(cleanup);

const LABEL = "Thinking level for this conversation";
const LEVELS: readonly EffortLevel[] = [
  { key: "off", label: "Off" },
  { key: "low", label: "Low", hint: "Model's default" },
  { key: "medium", label: "Medium" },
];

function renderEffort(props: Partial<Parameters<typeof ThinkingEffort>[0]> = {}) {
  const onSelect = vi.fn();
  render(
    <ThinkingEffort
      label={LABEL}
      levels={LEVELS}
      selectedKey="low"
      onSelect={onSelect}
      {...props}
    />,
  );
  return { onSelect, group: screen.getByRole("group", { name: LABEL }) };
}

describe("ThinkingEffort (KOBE-556)", () => {
  it("renders one pill per level, the selected one pressed, in a labelled group", () => {
    const { group } = renderEffort();
    const pills = within(group).getAllByRole("button");
    expect(pills.map((b) => b.textContent)).toEqual(["Off", "Low", "Medium"]);
    expect(pills.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
    // The hint is the pill's tooltip and its accessible description (touch, screen readers).
    const low = within(group).getByRole("button", { name: "Low", description: "Model's default" });
    expect(low.title).toBe("Model's default");
    expect(within(group).getByRole("button", { name: "Off", description: "" })).toBeTruthy();
  });

  it("chooses with a click, Enter or Space", async () => {
    const { onSelect, group } = renderEffort();
    const user = userEvent.setup();
    await user.click(within(group).getByRole("button", { name: "Medium" }));
    expect(onSelect).toHaveBeenLastCalledWith("medium");
    within(group).getByRole("button", { name: "Off" }).focus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith("off");
    await user.tab();
    await user.keyboard(" ");
    expect(onSelect).toHaveBeenLastCalledWith("low");
  });

  it("no pill is pressed when nothing is selected", () => {
    const { group } = renderEffort({ selectedKey: null });
    const pressed = within(group)
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressed).toEqual([]);
  });

  it("disabled: every pill is disabled and nothing is chosen", async () => {
    const { onSelect, group } = renderEffort({ disabled: true });
    for (const pill of within(group).getAllByRole("button"))
      expect(pill).toHaveProperty("disabled", true);
    await userEvent.setup().click(within(group).getByRole("button", { name: "Off" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("never renders a progress bar or a spent / budget readout (KOBE-574)", () => {
    const { group } = renderEffort();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(group.textContent).toBe(`${LABEL}Model's defaultOffLowMedium`);
  });

  it("the pressed pill is the inverted foreground fill; the others stay transparent (KOBE-574)", () => {
    const { group } = renderEffort();
    const low = within(group).getByRole("button", { name: "Low" });
    const off = within(group).getByRole("button", { name: "Off" });
    for (const cls of ["bg-foreground", "text-background"]) expect(low.classList).toContain(cls);
    expect(low.classList).not.toContain("bg-background");
    expect(low.className).toMatch(/forced-colors:aria-pressed:outline/);
    expect(off.classList).toContain("enabled:hover:text-foreground");
    expect(off.classList).not.toContain("bg-foreground");
  });

  it("centres the pill text vertically in both sizes (KOBE-574)", () => {
    // data-slot opts out of the chat's button padding and line height (KOBE-558); flex centres.
    for (const [compact, height] of [
      [false, "h-6"],
      [true, "h-5"],
    ] as const) {
      const { group } = renderEffort({ compact });
      for (const pill of within(group).getAllByRole("button")) {
        expect(pill.getAttribute("data-slot")).toBe("thinking-pill");
        for (const cls of ["inline-flex", "items-center", "justify-center", height])
          expect(pill.classList).toContain(cls);
      }
      cleanup();
    }
  });

  it("the compact variant is the same pills at the smaller size", () => {
    const { group } = renderEffort({ compact: true });
    expect(group.getAttribute("data-size")).toBe("compact");
    expect(within(group).getAllByRole("button")).toHaveLength(3);
  });
});
