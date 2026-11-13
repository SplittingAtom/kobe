import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { isWriteTool, zodOf, type KobeRouteCaller, type KobeWriteTool } from "../catalog.js";
import {
  WORKSPACE_WIRE_KEYS,
  toWorkspaceWire,
  workspaceMemoryWireSchema,
  workspacePutSchema,
} from "../../memory/settings-wire.js";
import { WORKSPACE_SWITCHES_ON } from "../../memory/switch-model.js";
import { teamMemoryGet, teamMemorySet as setTool } from "./team-memory.js";

if (!isWriteTool(setTool)) throw new Error("team_memory_set must be a write tool");
const teamMemorySet: KobeWriteTool = setTool;

/**
 * Contract of `team_memory_get` / `team_memory_set` (KOBE-381 ac-5, KOBE-621): the tools speak the
 * route's own wire shape for every Workspace switch and the learning model override, a write is
 * approved against the full before-state and sent as the route's `expected` (409
 * `changed_since_approval` when anything moved), and the approval summary names each change.
 */

const ON = toWorkspaceWire(WORKSPACE_SWITCHES_ON);
const answer =
  (body: unknown, status = 200): KobeRouteCaller =>
  () =>
    Promise.resolve({ status, body });

describe("team_memory_get / team_memory_set contract (ac-5)", () => {
  it("cover every Workspace switch and the learning model override", () => {
    expect(WORKSPACE_WIRE_KEYS).toEqual([
      "memory_enabled",
      "project_memory_enabled",
      "memories_enabled",
      "workspace_memories_enabled",
      "site_memories_enabled",
      "learn_enabled",
      "site_proposals_enabled",
      "learning_model_alias",
    ]);
    // The route's answer shape is the tool's output, key for key.
    expect(Object.keys((zodOf(teamMemoryGet.output) as z.ZodObject).shape)).toEqual(
      WORKSPACE_WIRE_KEYS,
    );
    expect(teamMemoryGet.output).toBe(workspaceMemoryWireSchema);
    expect(teamMemorySet.output).toBe(workspaceMemoryWireSchema);
    expect(teamMemoryGet.reduce(ON, {})).toEqual(ON);
  });

  it("set needs the full before-state; the old two-key from is refused", () => {
    const ok = teamMemorySet.input.safeParse({ from: ON, to: { learn_enabled: false } });
    expect(ok.success).toBe(true);
    const old = teamMemorySet.input.safeParse({
      from: { memory_enabled: true, project_memory_enabled: true },
      to: { memory_enabled: false },
    });
    expect(old.success).toBe(false);
    expect(teamMemorySet.input.safeParse({ from: ON, to: {} }).success).toBe(false);
  });

  it("sends the change with the before-state as expected, in the route's PUT shape", () => {
    const input = teamMemorySet.input.parse({
      from: ON,
      to: { site_memories_enabled: false, learning_model_alias: "m-1" },
    });
    const route = teamMemorySet.route(input);
    expect(route).toEqual({
      method: "PUT",
      path: "/memory/settings",
      query: { level: "team" },
      body: { site_memories_enabled: false, learning_model_alias: "m-1", expected: ON },
    });
    expect(workspacePutSchema.safeParse(route.body).success).toBe(true);
  });

  it.each(WORKSPACE_WIRE_KEYS.map((k) => [k]))(
    "before-state: a change to %s since approval reads as changed",
    async (key) => {
      const input = teamMemorySet.input.parse({ from: ON, to: { memory_enabled: false } });
      const before = teamMemorySet.before;
      if (!before) throw new Error("team_memory_set has no before-state check");
      expect(await before(input, answer(ON))).toBe("same");
      const moved = { ...ON, [key]: key === "learning_model_alias" ? "m-2" : false };
      expect(await before(input, answer(moved))).toBe("changed");
    },
  );

  it("an unreadable answer reads as changed", async () => {
    const input = teamMemorySet.input.parse({ from: ON, to: { memory_enabled: false } });
    expect(await teamMemorySet.before(input, answer({ memory_enabled: true }))).toBe("changed");
    expect(await teamMemorySet.before(input, answer(ON, 403))).toBe("changed");
  });

  it("the approval summary names each change in plain words", () => {
    const input = teamMemorySet.input.parse({
      from: { ...ON, learning_model_alias: "m-1" },
      to: { learn_enabled: false, learning_model_alias: null },
    });
    expect(teamMemorySet.summary(input)).toBe(
      "Learn from this chat: on → off; Learning model: m-1 → none",
    );
  });
});
