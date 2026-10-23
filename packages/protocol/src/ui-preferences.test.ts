import { describe, expect, it } from "vitest";
import {
  ARTIFACT_WIDTH_BOUNDS,
  RAIL_WIDTH_BOUNDS,
  readUiPreferences,
  THREADS_SHARE_BOUNDS,
  uiPreferencesSchema,
  WORKBENCH_EDITOR_WIDTH_BOUNDS,
} from "./ui-preferences.js";

/** KOBE-202 (CE8): the layout preferences a user stores. */
describe("uiPreferencesSchema", () => {
  it("accepts each key on its own, and none", () => {
    expect(uiPreferencesSchema.parse({})).toEqual({});
    expect(uiPreferencesSchema.parse({ rail_collapsed: true })).toEqual({ rail_collapsed: true });
    expect(uiPreferencesSchema.parse({ threads_share: 0.45 })).toEqual({ threads_share: 0.45 });
    expect(uiPreferencesSchema.parse({ artifact_width: 720 })).toEqual({ artifact_width: 720 });
    expect(uiPreferencesSchema.parse({ artifact_width: null })).toEqual({ artifact_width: null });
    expect(uiPreferencesSchema.parse({ detail_expanded: true })).toEqual({ detail_expanded: true });
    expect(uiPreferencesSchema.parse({ rail_width: 360 })).toEqual({ rail_width: 360 });
    expect(uiPreferencesSchema.parse({ rail_width: null })).toEqual({ rail_width: null });
    for (const panels of ["both", "threads", "files"] as const) {
      expect(uiPreferencesSchema.parse({ rail_panels: panels })).toEqual({ rail_panels: panels });
    }
    // KOBE-448: the rail section's last tab.
    for (const tab of ["files", "apps"] as const) {
      expect(uiPreferencesSchema.parse({ rail_tab: tab })).toEqual({ rail_tab: tab });
    }
    // KOBE-459: the Workbench editor rail's dragged width.
    expect(uiPreferencesSchema.parse({ workbench_editor_width: 640 })).toEqual({
      workbench_editor_width: 640,
    });
    expect(uiPreferencesSchema.parse({ workbench_editor_width: null })).toEqual({
      workbench_editor_width: null,
    });
    // KOBE-460: the rail's picker app (its app id), or none.
    const picker = "a".repeat(64);
    expect(uiPreferencesSchema.parse({ rail_picker: picker })).toEqual({ rail_picker: picker });
    expect(uiPreferencesSchema.parse({ rail_picker: null })).toEqual({ rail_picker: null });
    // KOBE-489: open the agent's proposed edits automatically.
    expect(uiPreferencesSchema.parse({ auto_open_edits: true })).toEqual({ auto_open_edits: true });
    expect(uiPreferencesSchema.parse({ auto_open_edits: false })).toEqual({
      auto_open_edits: false,
    });
  });

  it("refuses unknown keys (strict, not stripped)", () => {
    expect(uiPreferencesSchema.safeParse({ rail_collapsed: true, theme: "dark" }).success).toBe(
      false,
    );
  });

  it("clamps the threads share to the rail's bounds and rounds it", () => {
    expect(uiPreferencesSchema.parse({ threads_share: 0.95 }).threads_share).toBe(
      THREADS_SHARE_BOUNDS.max,
    );
    expect(uiPreferencesSchema.parse({ threads_share: 0 }).threads_share).toBe(
      THREADS_SHARE_BOUNDS.min,
    );
    expect(uiPreferencesSchema.parse({ threads_share: 0.333333 }).threads_share).toBe(0.333);
  });

  it.each([
    { threads_share: 1.01 },
    { threads_share: -0.1 },
    { threads_share: Number.NaN },
    { artifact_width: ARTIFACT_WIDTH_BOUNDS.min - 1 },
    { rail_width: RAIL_WIDTH_BOUNDS.min - 1 },
    { rail_width: RAIL_WIDTH_BOUNDS.max + 1 },
    { rail_width: 300.5 },
    { rail_width: "300" },
    { artifact_width: ARTIFACT_WIDTH_BOUNDS.max + 1 },
    { artifact_width: 400.5 },
    { artifact_width: "400" },
    { rail_collapsed: 1 },
    { detail_expanded: "yes" },
    { rail_panels: "none" },
    { rail_picker: "A".repeat(64) },
    { rail_picker: "a".repeat(63) },
    { rail_picker: 1 },
    { auto_open_edits: "on" },
    { auto_open_edits: null },
    { rail_panels: null },
    { rail_panels: ["threads"] },
    { rail_tab: "threads" },
    { rail_tab: null },
    { workbench_editor_width: WORKBENCH_EDITOR_WIDTH_BOUNDS.min - 1 },
    { workbench_editor_width: WORKBENCH_EDITOR_WIDTH_BOUNDS.max + 1 },
    { workbench_editor_width: 500.5 },
    { workbench_editor_width: "500" },
  ])("refuses %o", (body) => {
    expect(uiPreferencesSchema.safeParse(body).success).toBe(false);
  });

  it("accepts the width bounds themselves", () => {
    for (const w of [ARTIFACT_WIDTH_BOUNDS.min, ARTIFACT_WIDTH_BOUNDS.max]) {
      expect(uiPreferencesSchema.parse({ artifact_width: w })).toEqual({ artifact_width: w });
    }
    for (const w of [RAIL_WIDTH_BOUNDS.min, RAIL_WIDTH_BOUNDS.max]) {
      expect(uiPreferencesSchema.parse({ rail_width: w })).toEqual({ rail_width: w });
    }
  });
});

describe("readUiPreferences", () => {
  it("keeps valid keys and drops unknown or invalid ones", () => {
    expect(
      readUiPreferences({
        rail_collapsed: false,
        detail_expanded: true,
        artifact_width: 12,
        old_key: 1,
        threads_share: 2,
      }),
    ).toEqual({ rail_collapsed: false, detail_expanded: true });
  });

  it("reads a stored rail width, dropping one out of bounds (KOBE-305)", () => {
    expect(readUiPreferences({ rail_width: 360 })).toEqual({ rail_width: 360 });
    expect(readUiPreferences({ rail_width: null })).toEqual({ rail_width: null });
    expect(readUiPreferences({ rail_width: 9000 })).toEqual({});
  });

  it("reads a stored Workbench editor width, dropping one out of bounds (KOBE-459)", () => {
    expect(readUiPreferences({ workbench_editor_width: 700 })).toEqual({
      workbench_editor_width: 700,
    });
    expect(readUiPreferences({ workbench_editor_width: 10 })).toEqual({});
  });

  it("reads the auto-open switch, dropping a non-boolean (KOBE-489)", () => {
    expect(readUiPreferences({ auto_open_edits: true })).toEqual({ auto_open_edits: true });
    expect(readUiPreferences({ auto_open_edits: 1 })).toEqual({});
  });

  it("drops a share outside the rail's bounds instead of clamping it", () => {
    expect(readUiPreferences({ threads_share: 0.95 })).toEqual({});
    expect(readUiPreferences({ threads_share: 0.8 })).toEqual({ threads_share: 0.8 });
  });

  it.each([null, undefined, [], "x", 3])("reads %o as no preferences", (raw) => {
    expect(readUiPreferences(raw)).toEqual({});
  });
});
