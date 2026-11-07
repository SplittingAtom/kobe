// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { ThinkingEffort, type EffortLevel } from "./thinking-effort";

/**
 * KOBE-556: assistant-ui's Reasoning effort element, vendored and restyled: one pill per level
 * with aria-pressed, the group's sr-only label, and the readout and bar only when both the spend
 * and the budget are known.
 */
afterEach(cleanup);

const LABEL = "Thinking level for this conversation";
const LEVELS: readonly EffortLevel[] = [
  { key: "off", label: "Off" },
  { key: "low", label: "Low", title: "Model's default" },
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
    expect(within(group).getByRole("button", { name: "Low" })).toHaveProperty(
      "title",
      "Model's default",
    );
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
    for (const pill of within(group).getAllByRole("button")) expect(pill).toHaveProperty("disabled", true);
    await userEvent.setup().click(within(group).getByRole("button", { name: "Off" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("hides the readout and the bar while the spend or the budget is unknown", () => {
    renderEffort();
    expect(screen.queryByRole("progressbar")).toBeNull();
    cleanup();
    renderEffort({ spent: 1200 });
    expect(screen.queryByRole("progressbar")).toBeNull();
    cleanup();
    renderEffort({ budget: 8000 });
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("shows spent / budget and a brand-accent bar when both are known", () => {
    renderEffort({ spent: 2000, budget: 8000 });
    const bar = screen.getByRole("progressbar", { name: "Thinking budget used" });
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(bar.getAttribute("aria-valuetext")).toBe("2,000 of 8,000 thinking tokens");
    expect(screen.getByText("2,000 / 8,000")).toBeTruthy();
    const fill = must(bar.firstElementChild as HTMLElement | null);
    expect(fill.style.width).toBe("25%");
    expect(fill.className).toMatch(/(^|\s)bg-brand-primary(\s|$)/);
  });

  it("an estimate shows ≈ and says so to screen readers; a spend past the budget fills the bar", () => {
    renderEffort({ spent: 9000, budget: 8000, estimated: true });
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(bar.getAttribute("aria-valuetext")).toBe(
      "about 9,000 of 8,000 thinking tokens (estimated)",
    );
    expect(screen.getByText("≈9,000 / 8,000")).toBeTruthy();
  });

  it("a zero budget (thinking off) shows no bar", () => {
    renderEffort({ spent: 0, budget: 0 });
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("the compact variant is the same pills at the smaller size", () => {
    const { group } = renderEffort({ compact: true });
    expect(group.getAttribute("data-size")).toBe("compact");
    expect(within(group).getAllByRole("button")).toHaveLength(3);
  });
});
