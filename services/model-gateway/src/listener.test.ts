import { randomUUID } from "node:crypto";
import { SecretBox, VIRTUAL_KEY_PURPOSE, virtualKeyContext } from "@kobe/db";
import { describe, expect, it } from "vitest";
import { applyModelsHint } from "./listener.js";
import { PrincipalCache } from "./principals.js";

describe("applyModelsHint", () => {
  it("drops a team's cached keys on keys:<team>, nothing on other hints", async () => {
    const box = new SecretBox("v".repeat(40), VIRTUAL_KEY_PURPOSE);
    const team = randomUUID();
    const user = randomUUID();
    let loads = 0;
    const cache = new PrincipalCache(
      {
        load: async () => {
          loads++;
          return {
            member: true,
            sandbox: "live",
            virtualKey: { id: "v", valueEnc: box.seal("sk-bf-1", virtualKeyContext(team, user)) },
          };
        },
        requestKey: async () => undefined,
      },
      box,
      { ttlMs: 60_000 },
    );
    await cache.resolve(team, user, "s");
    await cache.resolve(team, user, "s");
    expect(loads).toBe(1);
    applyModelsHint(cache, "config");
    applyModelsHint(cache, `keys:${randomUUID()}`);
    await cache.resolve(team, user, "s");
    expect(loads).toBe(1);
    applyModelsHint(cache, `keys:${team}`);
    await cache.resolve(team, user, "s");
    expect(loads).toBe(2);
  });
});
