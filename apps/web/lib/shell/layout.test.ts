import { describe, expect, it } from "vitest";
import { bandFor, bandFromMatches, BAND_QUERIES, BREAKPOINTS, layoutAt, RAIL_PX } from "./layout";

const open = { railCollapsed: false, artifactOpen: true, artifactWidth: null } as const;

describe("bands (CE7)", () => {
  it("maps window widths to the four rows of the table", () => {
    expect(bandFor(1280)).toBe("wide");
    expect(bandFor(1100)).toBe("wide");
    expect(bandFor(1099)).toBe("medium");
    expect(bandFor(960)).toBe("medium");
    expect(bandFor(820)).toBe("medium");
    expect(bandFor(819)).toBe("overlay");
    expect(bandFor(800)).toBe("overlay");
    expect(bandFor(768)).toBe("overlay");
    expect(bandFor(767)).toBe("single");
    expect(bandFor(390)).toBe("single");
  });

  it("reads the same band from the media queries", () => {
    const at = (w: number) =>
      bandFromMatches({
        wide: w >= BREAKPOINTS.wide,
        medium: w >= BREAKPOINTS.medium,
        overlay: w >= BREAKPOINTS.overlay,
      });
    for (const w of [1280, 1100, 960, 820, 800, 768, 390]) expect(at(w)).toBe(bandFor(w));
    expect(BAND_QUERIES.wide).toBe("(min-width: 1100px)");
    expect(BAND_QUERIES.medium).toBe("(min-width: 820px)");
    expect(BAND_QUERIES.overlay).toBe("(min-width: 768px)");
  });
});

describe("yield order and floors (CE7)", () => {
  it("1280: rail 280, artifact half of the rest, conversation the other half", () => {
    const l = layoutAt({ ...open, width: 1280 });
    expect(l).toMatchObject({ band: "wide", rail: 280, artifactMode: "column" });
    expect(l.artifact).toBe(500);
    expect(l.conversation).toBe(500);
  });

  it("1280: a dragged width is honoured while it fits, clamped to the conversation's floor", () => {
    expect(layoutAt({ ...open, width: 1280, artifactWidth: 450 }).artifact).toBe(450);
    expect(layoutAt({ ...open, width: 1280, artifactWidth: 900 })).toMatchObject({
      artifact: 600,
      conversation: 400,
    });
  });

  it("960: the rail yields first (48 px), then the artifact column shrinks toward 360", () => {
    const l = layoutAt({ ...open, width: 960, artifactWidth: 700 });
    expect(l).toMatchObject({ band: "medium", rail: RAIL_PX.collapsed, artifactMode: "column" });
    expect(l.artifact).toBe(512);
    expect(l.conversation).toBe(400);
    expect(layoutAt({ ...open, width: 820 })).toMatchObject({ artifact: 372, conversation: 400 });
  });

  it("800: the artifact column overlays the conversation, which keeps the whole width", () => {
    const l = layoutAt({ ...open, width: 800 });
    expect(l).toMatchObject({ band: "overlay", rail: 48, artifactMode: "overlay" });
    expect(l.conversation).toBe(752);
  });

  it("390: one column; the rail is a drawer and the artifact a full-screen sheet", () => {
    const l = layoutAt({ ...open, width: 390 });
    expect(l).toMatchObject({ band: "single", rail: 0, artifactMode: "sheet", conversation: 390 });
  });

  it("the conversation never measures under 400 px from 768 px up", () => {
    for (let width = BREAKPOINTS.overlay; width <= 2000; width += 1) {
      for (const artifactWidth of [null, 360, 600, 1200]) {
        for (const railCollapsed of [false, true]) {
          const l = layoutAt({ width, railCollapsed, artifactOpen: true, artifactWidth });
          expect(
            l.conversation,
            `${width} ${artifactWidth} ${railCollapsed}`,
          ).toBeGreaterThanOrEqual(400);
          if (l.artifactMode === "column") expect(l.artifact).toBeGreaterThanOrEqual(360);
        }
      }
    }
  });

  it("manual choices hold only while they fit and come back when the window grows (ac-2)", () => {
    const chosen = { railCollapsed: false, artifactOpen: true, artifactWidth: 640 } as const;
    expect(layoutAt({ ...chosen, width: 1400 })).toMatchObject({ rail: 280, artifact: 640 });
    expect(layoutAt({ ...chosen, width: 960 })).toMatchObject({ rail: 48, artifact: 512 });
    expect(layoutAt({ ...chosen, width: 1400 })).toMatchObject({ rail: 280, artifact: 640 });
    const collapsed = { ...chosen, railCollapsed: true };
    expect(layoutAt({ ...collapsed, width: 1400 }).rail).toBe(48);
  });

  it("no artifact open: the conversation takes everything right of the rail", () => {
    const none = { railCollapsed: false, artifactOpen: false, artifactWidth: null } as const;
    expect(layoutAt({ ...none, width: 1280 })).toMatchObject({
      artifactMode: "none",
      artifact: 0,
      conversation: 1000,
    });
    expect(layoutAt({ ...none, width: 960 })).toMatchObject({ rail: 48, conversation: 912 });
  });
});
