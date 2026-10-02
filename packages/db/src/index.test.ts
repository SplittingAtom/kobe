import { describe, expect, it } from "vitest";
import { TEAM_ID_SETTING } from "./index.js";

describe("@kobe/db", () => {
  it("names the Postgres setting that RLS policies read the team from", () => {
    expect(TEAM_ID_SETTING).toBe("kobe.team_id");
  });
});
