import { describe, expect, it } from "vitest";
import { deletableKey, ownedKey } from "./blobs.js";

const T = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const V = "33333333-3333-4333-8333-333333333333";
const P = "kobe/";

describe("which object keys retention may touch", () => {
  it("keeps to the team's key space and the owner's own user keys", () => {
    expect(ownedKey(P, T, U, `${P}teams/${T}/uploads/a`)).toBe(true);
    expect(ownedKey(P, T, U, `${P}teams/${T}/users/${U}/shared/x`)).toBe(true);
    expect(ownedKey(P, T, U, `${P}teams/${T}/users/${V}/shared/x`)).toBe(false);
    expect(ownedKey(P, T, U, `${P}teams/${V}/uploads/a`)).toBe(false);
    expect(ownedKey(P, T, U, `teams/${T}/uploads/a`)).toBe(false);
    expect(ownedKey(P, T, U, `${P}teams/${T}/`)).toBe(false);
    expect(ownedKey(P, T, U, `${P}teams/${T}/uploads/../../${V}/x`)).toBe(false);
    expect(ownedKey(P, T, U, `${P}teams/${T}//x`)).toBe(false);
  });

  it("never deletes workspace content-addressed blobs (workspace sync collects them)", () => {
    expect(deletableKey(P, T, U, `${P}teams/${T}/users/${U}/workspace/${"a".repeat(64)}`)).toBe(
      false,
    );
    expect(deletableKey(P, T, U, `${P}teams/${T}/users/${U}/shared/x`)).toBe(true);
    expect(deletableKey(P, T, U, `${P}teams/${T}/uploads/a`)).toBe(true);
    expect(deletableKey("", T, U, `teams/${T}/uploads/a`)).toBe(true);
  });
});
