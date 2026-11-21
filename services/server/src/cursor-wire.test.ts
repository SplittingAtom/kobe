import { describe, expect, it } from "vitest";
import {
  decodeCursor as decodeRoster,
  encodeCursor as encodeRoster,
} from "./agents/roster-list.js";
import { itemCursor } from "./memory/items/read.js";
import {
  decodeCursor as decodeNotice,
  encodeCursor as encodeNotice,
} from "./notifications/store.js";
import { blockCursor, decodeBlockCursor } from "./skills/blocklist.js";
import { decodeCursor as decodeReview, reviewCursor } from "./skills/review.js";
import { decodeActivityCursor, encodeActivityCursor } from "./threads/cursor.js";
import {
  decodeCursor as decodeBrowse,
  encodeCursor as encodeBrowse,
} from "./workspace-files/browse.js";

/**
 * KOBE-702: every list cursor moved to `makeCursorCodec`. Each token below was produced by the
 * module's previous hand-written encoder, so tokens already in clients' hands keep decoding and new
 * ones are byte-identical.
 */
const ID = "3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b";
const oversized = "e".repeat(5000);

describe("list cursors keep their wire format (KOBE-702)", () => {
  it("workspace folder listing", () => {
    const old = "eyJkIjoxLCJuIjoiUmVwb3J0cyDDqSJ9";
    expect(encodeBrowse({ dir: true, name: "Reports é" })).toBe(old);
    expect(decodeBrowse(old)).toEqual({ dir: true, name: "Reports é" });
    expect(decodeBrowse("garbage!")).toBeUndefined();
    expect(decodeBrowse(oversized)).toBeUndefined();
  });

  it("memory items", () => {
    const old =
      "eyJ1cyI6IjE3NTkzNzAwMDAxMjM0NTYiLCJpZCI6IjNmMmI4YzFlLTRhNWQtNGU2Zi04YTliLTBjMWQyZTNmNGE1YiJ9";
    expect(itemCursor.encode({ us: "1759370000123456", id: ID })).toBe(old);
    expect(itemCursor.decode(old)).toEqual({ us: "1759370000123456", id: ID });
    expect(itemCursor.decode(itemCursor.encode({ us: "x", id: ID }))).toBeUndefined();
  });

  it("agent roster", () => {
    const old = "WyJBbmFseXN0IOKckyIsIjNmMmI4YzFlLTRhNWQtNGU2Zi04YTliLTBjMWQyZTNmNGE1YiJd";
    expect(encodeRoster("Analyst ✓", ID)).toBe(old);
    expect(decodeRoster(old)).toEqual(["Analyst ✓", ID]);
    expect(decodeRoster(Buffer.from('["a"]').toString("base64url"))).toBeNull();
    expect(decodeRoster("garbage!")).toBeNull();
  });

  it("skill blocklist", () => {
    const at = "2026-11-20 10:00:00.123456+00";
    const old =
      "eyJhdCI6IjIwMjYtMTEtMjAgMTA6MDA6MDAuMTIzNDU2KzAwIiwiaGFzaCI6ImFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEifQ";
    expect(blockCursor.encode({ at, hash: "a".repeat(64) })).toBe(old);
    expect(decodeBlockCursor(old)).toEqual({ at, hash: "a".repeat(64) });
    expect(decodeBlockCursor("garbage!")).toBeUndefined();
  });

  it("team skill review", () => {
    const value = { flagged: true, at: "2026-11-20 10:00:00.123456+00", skillId: ID, version: 2 };
    const old =
      "eyJmbGFnZ2VkIjp0cnVlLCJhdCI6IjIwMjYtMTEtMjAgMTA6MDA6MDAuMTIzNDU2KzAwIiwic2tpbGxJZCI6IjNmMmI4YzFlLTRhNWQtNGU2Zi04YTliLTBjMWQyZTNmNGE1YiIsInZlcnNpb24iOjJ9";
    expect(reviewCursor.encode(value)).toBe(old);
    expect(decodeReview(old)).toEqual(value);
    expect(decodeReview(reviewCursor.encode({ ...value, version: 0 }))).toBeUndefined();
  });

  it("notifications", () => {
    const value = { t: "2026-11-20T10:00:00.123456Z", i: ID };
    const old =
      "eyJ0IjoiMjAyNi0xMS0yMFQxMDowMDowMC4xMjM0NTZaIiwiaSI6IjNmMmI4YzFlLTRhNWQtNGU2Zi04YTliLTBjMWQyZTNmNGE1YiJ9";
    expect(encodeNotice(value)).toBe(old);
    expect(decodeNotice(old)).toEqual(value);
    expect(decodeNotice(oversized)).toBeNull();
  });

  it("thread activity", () => {
    const old =
      "eyJhIjoiMTc1OTM3MDAwMDEyMzQ1NiIsImkiOiIzZjJiOGMxZS00YTVkLTRlNmYtOGE5Yi0wYzFkMmUzZjRhNWIifQ";
    expect(encodeActivityCursor({ micros: "1759370000123456", id: ID })).toBe(old);
    expect(decodeActivityCursor(old)).toEqual({ micros: "1759370000123456", id: ID });
    expect(decodeActivityCursor("e".repeat(257))).toBeNull();
  });
});
