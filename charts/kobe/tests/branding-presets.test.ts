import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PRESET_IDS } from "../../../packages/protocol/src/branding.js";
import { describe, expect, it } from "vitest";

// The chart schema's preset list (KOBE-503) must match the server's (TH9); no helm needed.

const SCHEMA = fileURLToPath(new URL("../values.schema.json", import.meta.url));

describe("values.schema.json branding.preset", () => {
  it("lists exactly the protocol's preset ids, plus empty for unset", () => {
    const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as {
      properties: { branding: { properties: { preset: { enum: string[] } } } };
    };
    expect(schema.properties.branding.properties.preset.enum).toEqual(["", ...PRESET_IDS]);
  });
});
