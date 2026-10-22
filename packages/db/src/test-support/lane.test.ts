import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isLaneObjectName,
  laneDatabaseName,
  laneFromDirectory,
  laneServerUrl,
  laneSuffix,
  resolveTestLane,
} from "./lane.js";

function workspace(name: string): string {
  const root = join(mkdtempSync(join(tmpdir(), "kobe-lane-")), name);
  mkdirSync(join(root, "services", "server"), { recursive: true });
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  return root;
}

describe("laneFromDirectory", () => {
  it("drops the repository name and keeps the worktree's distinguishing part", () => {
    expect(laneFromDirectory("Kobe-wt482")).toBe("wt482");
    expect(laneFromDirectory("Kobe")).toBe("kobe");
    expect(laneFromDirectory("my_Lane.2")).toBe("mylane2");
  });

  it("caps the lane at 20 characters and refuses a name with nothing usable", () => {
    expect(laneFromDirectory("x".repeat(40))).toHaveLength(20);
    expect(() => laneFromDirectory("---")).toThrow(/lane/);
  });
});

describe("resolveTestLane", () => {
  const root = workspace("Kobe-wt7");
  const cwd = join(root, "services", "server");

  it("uses KOBE_TEST_DB_LANE when set", () => {
    expect(resolveTestLane({ KOBE_TEST_DB_LANE: "Lane2" }, cwd)).toBe("lane2");
  });

  it("rejects a lane with characters outside [a-z0-9]", () => {
    expect(() => resolveTestLane({ KOBE_TEST_DB_LANE: "a_b" }, cwd)).toThrow(/KOBE_TEST_DB_LANE/);
    expect(() => resolveTestLane({ KOBE_TEST_DB_LANE: "x".repeat(21) }, cwd)).toThrow();
  });

  it("treats an empty KOBE_TEST_DB_LANE as no lane", () => {
    expect(resolveTestLane({ KOBE_TEST_DB_LANE: "" }, cwd)).toBeUndefined();
  });

  it("derives the lane from the workspace root's directory name", () => {
    expect(resolveTestLane({}, cwd)).toBe("wt7");
  });

  it("uses no lane in CI unless one is set explicitly", () => {
    expect(resolveTestLane({ CI: "true" }, cwd)).toBeUndefined();
    expect(resolveTestLane({ CI: "true", KOBE_TEST_DB_LANE: "ci1" }, cwd)).toBe("ci1");
  });

  it("uses no lane outside a workspace", () => {
    expect(resolveTestLane({}, mkdtempSync(join(tmpdir(), "kobe-nolane-")))).toBeUndefined();
  });
});

describe("lane names", () => {
  it("points the server URL at the lane database and leaves it alone without a lane", () => {
    const base = "postgres://u:p@db.example:5432/postgres?sslmode=disable";
    expect(laneDatabaseName("wt7")).toBe("kobe_lane_wt7");
    expect(laneServerUrl(base, "wt7")).toBe(
      "postgres://u:p@db.example:5432/kobe_lane_wt7?sslmode=disable",
    );
    expect(laneServerUrl(base, undefined)).toBe(base);
  });

  it("suffixes object names with the lane so a lane's leftovers are recognisable", () => {
    expect(laneSuffix("ab12cd34", "wt7")).toBe("ab12cd34_wt7");
    expect(laneSuffix("ab12cd34", undefined)).toBe("ab12cd34");
  });

  it("matches only the lane's own objects", () => {
    expect(isLaneObjectName("kobe_test_ab12cd34_wt7", "wt7")).toBe(true);
    expect(isLaneObjectName("kobe_up_owner_ab12cd34_wt7", "wt7")).toBe(true);
    expect(isLaneObjectName("kobe_lane_wt7", "wt7")).toBe(true);
    expect(isLaneObjectName("kobe_test_ab12cd34_wt71", "wt7")).toBe(false);
    expect(isLaneObjectName("kobe_test_ab12cd34_xwt7", "wt7")).toBe(false);
    expect(isLaneObjectName("kobe_test_ab12cd34", "wt7")).toBe(false);
    expect(isLaneObjectName("kobe_lane_wt71", "wt7")).toBe(false);
  });
});
