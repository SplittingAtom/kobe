import { describe, expect, it } from "vitest";
import { threadKey } from "./blobs.js";

const T = "11111111-1111-4111-8111-111111111111";
const H = "22222222-2222-4222-8222-222222222222";
const O = "33333333-3333-4333-8333-333333333333";
const P = "kobe/";

describe("which object keys retention and export may touch", () => {
  it("only keys in the thread's own tree", () => {
    expect(threadKey(P, T, H, `${P}teams/${T}/threads/${H}/entries/e1`)).toBe(true);
    expect(threadKey("", T, H, `teams/${T}/threads/${H}/a`)).toBe(true);
    // Another thread, another team, a member's or a workspace's objects, uploads elsewhere.
    expect(threadKey(P, T, H, `${P}teams/${T}/threads/${O}/a`)).toBe(false);
    expect(threadKey(P, T, H, `${P}teams/${O}/threads/${H}/a`)).toBe(false);
    expect(threadKey(P, T, H, `${P}teams/${T}/users/${O}/shared/x`)).toBe(false);
    expect(threadKey(P, T, H, `${P}teams/${T}/users/${O}/workspace/${"a".repeat(64)}`)).toBe(false);
    expect(threadKey(P, T, H, `${P}teams/${T}/uploads/a`)).toBe(false);
    expect(threadKey(P, T, H, `teams/${T}/threads/${H}/a`)).toBe(false);
  });

  it("refuses the bare tree, empty and dot segments, and non-uuid ids", () => {
    expect(threadKey(P, T, H, `${P}teams/${T}/threads/${H}/`)).toBe(false);
    expect(threadKey(P, T, H, `${P}teams/${T}/threads/${H}/../${O}/a`)).toBe(false);
    expect(threadKey(P, T, H, `${P}teams/${T}/threads/${H}//a`)).toBe(false);
    expect(threadKey(P, T, "x/..", `${P}teams/${T}/threads/x/../a`)).toBe(false);
  });
});
