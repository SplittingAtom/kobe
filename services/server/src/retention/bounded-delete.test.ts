import { describe, expect, it } from "vitest";
import type { ObjectStore } from "../workspace-sync/object-store.js";
import { deleteBounded, DeleteAbortedError } from "./bounded-delete.js";

/** KOBE-243: a delete that hangs is aborted, and settled, before deleteBounded gives up. */
function hangingStore(opts: { honoursSignal?: boolean; goneBeforeHang?: number } = {}) {
  const state = { deleted: [] as string[], settled: false, started: 0 };
  const objects = {
    delete(keys: readonly string[], options?: { signal?: AbortSignal }) {
      state.started++;
      return new Promise<void>((_resolve, reject) => {
        keys.slice(0, opts.goneBeforeHang ?? 0).forEach((k) => state.deleted.push(k));
        if (opts.honoursSignal === false) return; // never settles
        options?.signal?.addEventListener("abort", () => {
          // Settles a little later than the abort, like an in-flight request being torn down.
          setTimeout(() => {
            state.settled = true;
            reject(Object.assign(new Error("aborted"), { deleted: state.deleted.slice() }));
          }, 20);
        });
      });
    },
  } as unknown as ObjectStore;
  return { objects, state };
}

describe("deleteBounded", () => {
  it("passes the keys to the store and reports them deleted", async () => {
    const seen: string[] = [];
    const objects = {
      delete: (keys: readonly string[]) => {
        seen.push(...keys);
        return Promise.resolve();
      },
    } as unknown as ObjectStore;
    expect(await deleteBounded(objects, ["a", "b"], 1000)).toEqual({ deleted: ["a", "b"] });
    expect(seen).toEqual(["a", "b"]);
  });

  it("aborts on timeout and rejects only after the delete has settled", async () => {
    const { objects, state } = hangingStore({ goneBeforeHang: 1 });
    const err = await deleteBounded(objects, ["a", "b", "c"], 30).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeleteAbortedError);
    // The store call had settled (aborted) by the time we were told: nothing can run afterwards.
    expect(state.settled).toBe(true);
    const e = err as DeleteAbortedError;
    expect(e.deleted).toEqual(["a"]);
    expect(e.aborted).toEqual(["b", "c"]);
    const before = state.deleted.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(state.deleted.length).toBe(before);
  });

  it("treats every key as aborted when the store reports no progress", async () => {
    const objects = {
      delete: (_k: readonly string[], o?: { signal?: AbortSignal }) =>
        new Promise<void>((_res, rej) =>
          o?.signal?.addEventListener("abort", () => rej(new Error("x"))),
        ),
    } as unknown as ObjectStore;
    const err = (await deleteBounded(objects, ["a"], 10).catch(
      (e: unknown) => e,
    )) as DeleteAbortedError;
    expect(err.deleted).toEqual([]);
    expect(err.aborted).toEqual(["a"]);
  });

  it("gives up (and says so) on a store that ignores the signal", async () => {
    const { objects } = hangingStore({ honoursSignal: false });
    const err = await deleteBounded(objects, ["a"], 10, 30).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeleteAbortedError);
    expect((err as DeleteAbortedError).unsettled).toBe(true);
  });

  it("rethrows a plain store failure unchanged", async () => {
    const boom = new Error("boom");
    const objects = { delete: () => Promise.reject(boom) } as unknown as ObjectStore;
    await expect(deleteBounded(objects, ["a"], 1000)).rejects.toBe(boom);
  });
});
