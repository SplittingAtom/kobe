import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { EXPECTED_PACK } from "./pack.js";

describe("expected scenario pack", () => {
  it("equals the eval image's default pack", () => {
    const file = fileURLToPath(
      new URL("../../../../../images/orbit-eval/scenarios/default-pack.yaml", import.meta.url),
    );
    const pack = parse(readFileSync(file, "utf8")) as {
      id: string;
      version: number;
      scenarios: unknown[];
    };
    expect(EXPECTED_PACK).toEqual({
      id: pack.id,
      version: pack.version,
      scenarios: pack.scenarios.length,
    });
  });
});
