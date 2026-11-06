// @vitest-environment happy-dom
/** KOBE-545 (CT2): the `branches` read and its triggers. */
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ThreadBranchesResponse } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { BRANCHES_REREAD_MS, EMPTY_BRANCHES, readThreadBranches } from "./branches";
import { useBranches } from "./use-branches";
import { FakeKobe } from "./testing/fake-kobe";

const T = "0b0b0b0b-0000-4000-8000-000000000001";
const OTHER = "0b0b0b0b-0000-4000-8000-000000000002";
const answer: ThreadBranchesResponse = {
  labels: [{ entry_id: "e1", label: "try 5% cut" }],
  runs: [{ user_entry_id: "u1", remembered_rule: true }],
};

describe("readThreadBranches", () => {
  const answering =
    (status: number, body: unknown): typeof fetch =>
    async () =>
      new Response(JSON.stringify(body), { status });

  it("reads the route with the team header and validates the answer", async () => {
    let seen: { url: unknown; headers: Headers } | undefined;
    const read = await readThreadBranches(T, "team-1", async (url, init) => {
      seen = { url, headers: new Headers(init?.headers) };
      return new Response(JSON.stringify(answer), { status: 200 });
    });
    expect(read).toEqual(answer);
    expect(seen?.url).toBe(`/v1/threads/${T}/branches`);
    expect(seen?.headers.get("x-kobe-team")).toBe("team-1");
  });

  it("is null for an error, a malformed answer or a network failure (no error box)", async () => {
    expect(await readThreadBranches(T, "t", answering(404, { error: {} }))).toBeNull();
    expect(await readThreadBranches(T, "t", answering(200, { labels: "x", runs: [] }))).toBeNull();
    expect(
      await readThreadBranches(T, "t", async () => {
        throw new Error("offline");
      }),
    ).toBeNull();
  });
});

describe("the fake's branches route", () => {
  it("answers what a test set, empty by default, 500 when failing", async () => {
    const fake = new FakeKobe();
    const id = fake.addThread("Budget");
    expect(await readThreadBranches(id, fake.teamId, fake.fetch)).toEqual(EMPTY_BRANCHES);
    fake.branches.set(id, answer);
    expect(await readThreadBranches(id, fake.teamId, fake.fetch)).toEqual(answer);
    fake.branchesFailing.add(id);
    expect(await readThreadBranches(id, fake.teamId, fake.fetch)).toBeNull();
    expect(fake.branchesReads).toBe(3);
  });
});

describe("useBranches", () => {
  const source = (answers: (ThreadBranchesResponse | null)[]) => {
    const calls: string[] = [];
    return {
      calls,
      api: {
        getThreadBranches: async (id: string) => {
          calls.push(id);
          return answers.length > 1 ? (answers.shift() ?? null) : (answers[0] ?? null);
        },
      },
    };
  };

  it("reads on open, gives empty notes before and after a failed read", async () => {
    const s = source([null]);
    const { result } = renderHook(() => useBranches(T, s));
    expect(result.current.notes).toEqual(EMPTY_BRANCHES);
    await waitFor(() => expect(s.calls).toEqual([T]));
    expect(result.current.notes).toEqual(EMPTY_BRANCHES);
  });

  it("re-reads on refresh (a label change) and on focus once older than 60 s", async () => {
    let now = 1_000;
    const s = source([answer]);
    const { result } = renderHook(() => useBranches(T, s, () => now));
    await waitFor(() => expect(result.current.notes).toEqual(answer));
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(s.calls).toHaveLength(1);
    now += BRANCHES_REREAD_MS;
    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(s.calls).toHaveLength(2));
    act(() => result.current.refresh());
    await waitFor(() => expect(s.calls).toHaveLength(3));
  });

  it("drops an answer for a thread no longer on screen", async () => {
    let release: (v: ThreadBranchesResponse) => void = () => {};
    const slow = {
      api: {
        getThreadBranches: (id: string) =>
          id === T
            ? new Promise<ThreadBranchesResponse | null>((r) => (release = r))
            : Promise.resolve(null),
      },
    };
    const { result, rerender } = renderHook(({ id }) => useBranches(id, slow), {
      initialProps: { id: T },
    });
    rerender({ id: OTHER });
    await act(async () => release(answer));
    expect(result.current.notes).toEqual(EMPTY_BRANCHES);
  });
});
