import { describe, expect, it, vi } from "vitest";
import { answerInvite, fetchMyInvites, tokenFromHash, validateNewPassword } from "./invites";

describe("tokenFromHash", () => {
  it("reads the token from the fragment", () => {
    expect(tokenFromHash("#token=abcDEF123_-abcDEF123")).toBe("abcDEF123_-abcDEF123");
  });

  it.each(["", "#", "#token=", "#token=a b", "#token=<script>", "#other=abcdefabcdefabcdef"])(
    "rejects %j",
    (hash) => {
      expect(tokenFromHash(hash)).toBeNull();
    },
  );
});

describe("validateNewPassword", () => {
  it("applies the server's length rules and checks the confirmation", () => {
    expect(validateNewPassword("long enough pass", "long enough pass")).toBeNull();
    expect(validateNewPassword("short", "short")).toMatch(/12/);
    expect(validateNewPassword("x".repeat(129), "x".repeat(129))).toMatch(/128/);
    expect(validateNewPassword("long enough pass", "long enough pasS")).toMatch(/match/);
  });
});

describe("invitation API helpers", () => {
  it("treats signed-out as no invitations", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 401 }));
    expect(await fetchMyInvites(fetchFn as unknown as typeof fetch)).toEqual([]);
  });

  it("posts accept and decline to the team's invitation", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    await answerInvite("t-1", "accept", fetchFn as unknown as typeof fetch);
    expect(fetchFn).toHaveBeenCalledWith("/v1/me/invites/t-1/accept", { method: "POST" });
    const failing = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(
      answerInvite("t-1", "decline", failing as unknown as typeof fetch),
    ).rejects.toThrow(/no longer open/);
  });
});
