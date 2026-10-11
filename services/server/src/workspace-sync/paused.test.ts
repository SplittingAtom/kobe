import { describe, expect, it, vi } from "vitest";
import { createWorkspaceSync } from "./service.js";

/** KOBE-243: a paused install runs no workspace GC, timed or on quota pressure. */
describe("paused workspace GC", () => {
  it("collects nothing and never touches the database or bucket", async () => {
    const del = vi.fn();
    const sync = createWorkspaceSync({
      db: new Proxy({}, { get: () => () => Promise.reject(new Error("db touched")) }) as never,
      objects: { delete: del } as never,
      prefix: "",
      limits: { maxFileBytes: 1, maxWorkspaceBytes: 1, maxFiles: 1 },
      paused: true,
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    });
    expect(await sync.collect()).toEqual({ blobs: 0, bytes: 0, tombstones: 0 });
    await sync.settled();
    expect(del).not.toHaveBeenCalled();
  });
});
