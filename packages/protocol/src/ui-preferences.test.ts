import { describe, expect, it } from "vitest";
import {
  ARTIFACT_WIDTH_BOUNDS,
  readUiPreferences,
  THREADS_SHARE_BOUNDS,
  uiPreferencesSchema,
} from "./ui-preferences.js";

/** KOBE-202 (CE8): the layout preferences a user stores. */
describe("uiPreferencesSchema", () => {
  it("accepts each key on its own, and none", () => {
    expect(uiPreferencesSchema.parse({})).toEqual({});
    expect(uiPreferencesSchema.parse({ rail_collapsed: true })).toEqual({ rail_collapsed: true });
    expect(uiPreferencesSchema.parse({ threads_share: 0.45 })).toEqual({ threads_share: 0.45 });
    expect(uiPreferencesSchema.parse({ artifact_width: 720 })).toEqual({ artifact_width: 720 });
    expect(uiPreferencesSchema.parse({ artifact_width: null })).toEqual({ artifact_width: null });
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
    { artifact_width: ARTIFACT_WIDTH_BOUNDS.max + 1 },
    { artifact_width: 400.5 },
    { artifact_width: "400" },
    { rail_collapsed: 1 },
  ])("refuses %o", (body) => {
    expect(uiPreferencesSchema.safeParse(body).success).toBe(false);
  });

  it("accepts the width bounds themselves", () => {
    for (const w of [ARTIFACT_WIDTH_BOUNDS.min, ARTIFACT_WIDTH_BOUNDS.max]) {
      expect(uiPreferencesSchema.parse({ artifact_width: w })).toEqual({ artifact_width: w });
    }
  });
});

describe("readUiPreferences", () => {
  it("keeps valid keys and drops unknown or invalid ones", () => {
    expect(
      readUiPreferences({
        rail_collapsed: false,
        artifact_width: 12,
        old_key: 1,
        threads_share: 2,
      }),
    ).toEqual({ rail_collapsed: false });
  });

  it.each([null, undefined, [], "x", 3])("reads %o as no preferences", (raw) => {
    expect(readUiPreferences(raw)).toEqual({});
  });
});
