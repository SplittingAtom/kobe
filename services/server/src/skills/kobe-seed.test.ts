import { describe, expect, it } from "vitest";
import type { KobeDb } from "@kobe/db";
import type { BlobStore } from "../retention/blobs.js";
import { startKobeSeed, type KobeSeedResult } from "./kobe-seed.js";

const deps = {
  db: {} as KobeDb,
  blobs: {} as BlobStore,
  log: { info() {}, warn() {}, error() {} },
};
const result = (action: KobeSeedResult["action"]): KobeSeedResult[] => [
  { name: "pdf", semver: "1.0.0", action },
];

describe("startKobeSeed (review-317 S3)", () => {
  it("retries a failed seed with backoff until it gets through, then stops", async () => {
    const outcomes = [result("failed"), [], result("created"), result("unchanged")];
    let calls = 0;
    const seed = () => {
      const next = outcomes[calls] ?? result("unchanged");
      calls += 1;
      return calls === 2 ? Promise.reject(new Error("s3 down")) : Promise.resolve(next);
    };
    const runner = startKobeSeed(deps, { retry: { firstMs: 5, maxMs: 20 } }, seed);
    await runner.first;
    expect(calls).toBe(1);
    await runner.settled;
    expect(calls).toBe(3);
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBe(3);
  });

  it("treats a refusal as final and stop() ends the retries", async () => {
    let calls = 0;
    const refused = startKobeSeed(deps, { retry: { firstMs: 5, maxMs: 5 } }, () => {
      calls += 1;
      return Promise.resolve(result("refused"));
    });
    await refused.settled;
    expect(calls).toBe(1);
    let failing = 0;
    const stopped = startKobeSeed(deps, { retry: { firstMs: 5, maxMs: 5 } }, () => {
      failing += 1;
      return Promise.resolve(result("failed"));
    });
    await stopped.first;
    stopped.stop();
    await new Promise((r) => setTimeout(r, 40));
    expect(failing).toBe(1);
  });
});
