import { describe, expect, it } from "vitest";
import type { TeamModel, TeamModels } from "../admin/api/team/models";
import { aliasName, modelChoices, teamDefaultLabel } from "./model-choices";

const model = (alias: string, label: string | null, enabled: boolean): TeamModel =>
  ({ alias, label, enabled, isDefault: false }) as unknown as TeamModel;

const data: TeamModels = {
  models: [model("kimi", "Kimi", true), model("glm", "GLM", true), model("gpt", null, false)],
  default: "kimi",
};

describe("modelChoices (KOBE-44, KOBE-217)", () => {
  it("offers the enabled models; null follows the team default", () => {
    const c = modelChoices(data, null, null);
    expect(c.enabled.map((m) => m.alias)).toEqual(["kimi", "glm"]);
    expect(c.chosen).toBeNull();
    expect(c.unavailable).toBe(false);
    expect(teamDefaultLabel(c)).toBe("Team default (Kimi)");
  });

  it("marks a choice the team disabled since as unavailable", () => {
    expect(modelChoices(data, "gpt", null).unavailable).toBe(true);
    expect(aliasName(data, "gpt")).toBe("gpt");
    expect(aliasName(data, "glm")).toBe("GLM");
  });

  it("names the agent's pin, and a default that isn't enabled is plain 'Team default'", () => {
    expect(modelChoices(data, "glm", "kimi").pinned).toBe("kimi");
    const noDefault = modelChoices({ ...data, default: "gpt" }, null, null);
    expect(noDefault.defaultModel).toBeUndefined();
    expect(teamDefaultLabel(noDefault)).toBe("Team default");
  });
});
