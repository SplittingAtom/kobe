// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ThinkingLevel } from "@kobe/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TeamModel, TeamModels } from "../../lib/admin/api/team/models";
import { ThinkingPicker, shownThinking } from "./thinking-picker";

/**
 * KOBE-556 (on KOBE-260's rules): the conversation's thinking level as Reasoning effort pills:
 * the levels the team allows, the member's choice else the default pressed, the default pill
 * titled "Model's default" and choosing it stores null.
 */
afterEach(cleanup);

const GROUP = { name: "Thinking level for this conversation" } as const;

function teamModels(thinking: TeamModel["thinkingInTeam"]): TeamModels {
  return {
    default: "glm",
    models: [
      { alias: "glm", enabled: true, isDefault: true, thinkingInTeam: thinking } as TeamModel,
    ],
  };
}

function renderPicker({
  levels = ["off", "low", "medium"] as readonly ThinkingLevel[],
  fallback = "low" as ThinkingLevel | null,
  chosen = null as ThinkingLevel | null,
  disabled = false,
  compact = false,
} = {}) {
  const onChoose = vi.fn();
  render(
    <ThinkingPicker
      models={teamModels({ default: fallback, levels })}
      alias={null}
      chosen={chosen}
      disabled={disabled}
      onChoose={onChoose}
      compact={compact}
    />,
  );
  return { onChoose, group: screen.queryByRole("group", GROUP) };
}

const pills = (group: HTMLElement | null) => within(group as HTMLElement).getAllByRole("button");
const pressed = (group: HTMLElement | null) =>
  pills(group)
    .filter((b) => b.getAttribute("aria-pressed") === "true")
    .map((b) => b.textContent);

describe("ThinkingPicker as Reasoning effort pills (KOBE-556)", () => {
  it("is absent without levels to choose, and never a select", () => {
    const { group } = renderPicker({ levels: [], fallback: null });
    expect(group).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it.each([
    [
      ["off", "low", "medium", "high"],
      ["Off", "Low", "Medium", "High"],
    ],
    [
      ["low", "medium"],
      ["Low", "Medium"],
    ],
    [
      ["off", "low"],
      ["Off", "Low"],
    ],
  ] as const)("one pill per allowed level: %j", (levels, labels) => {
    const { group } = renderPicker({ levels, fallback: levels[0] });
    expect(pills(group).map((b) => b.textContent)).toEqual(labels);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("no choice: the default level is pressed and titled Model's default", () => {
    const { group } = renderPicker();
    expect(pressed(group)).toEqual(["Low"]);
    const low = within(group as HTMLElement).getByRole("button", {
      name: "Low",
      description: "Model's default",
    });
    expect(low.title).toBe("Model's default");
    expect(within(group as HTMLElement).getByRole("button", { name: "Off" }).title).toBe("");
  });

  it("a choice is pressed instead; a level above the team's maximum shows as what runs get", () => {
    expect(pressed(renderPicker({ chosen: "off" }).group)).toEqual(["Off"]);
    cleanup();
    expect(pressed(renderPicker({ chosen: "high" }).group)).toEqual(["Medium"]);
  });

  it("choosing a level stores it; choosing the default stores null", async () => {
    const { onChoose, group } = renderPicker({ chosen: "off" });
    const user = userEvent.setup();
    await user.click(within(group as HTMLElement).getByRole("button", { name: "Medium" }));
    expect(onChoose).toHaveBeenLastCalledWith("medium");
    await user.click(within(group as HTMLElement).getByRole("button", { name: "Low" }));
    expect(onChoose).toHaveBeenLastCalledWith(null);
  });

  it("disabled (no thread yet, read-only): the pills don't choose", async () => {
    const { onChoose, group } = renderPicker({ disabled: true });
    for (const pill of pills(group)) expect(pill).toHaveProperty("disabled", true);
    await userEvent
      .setup()
      .click(within(group as HTMLElement).getByRole("button", { name: "Off" }));
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("compact on the line below the composer (KOBE-450)", () => {
    const { group } = renderPicker({ compact: true });
    expect(group?.getAttribute("data-size")).toBe("compact");
  });
});

describe("shownThinking (KOBE-260 clamping)", () => {
  it("keeps an allowed choice, lowers one above the maximum, raises one below the lowest", () => {
    expect(shownThinking("low", ["off", "low"])).toBe("low");
    expect(shownThinking("high", ["off", "low"])).toBe("low");
    expect(shownThinking("off", ["low", "medium"])).toBe("low");
    expect(shownThinking(null, ["low"])).toBeNull();
  });
});
