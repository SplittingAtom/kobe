import { describe, expect, it } from "vitest";
import { createFoldersApi } from "./folders-api";
import { FakeKobe } from "./testing/fake-kobe";

describe("the folders API (KOBE-536)", () => {
  it("lists, creates, renames, moves, deletes and files, validated against the protocol", async () => {
    const fake = new FakeKobe();
    const api = createFoldersApi(fake.teamId, fake.fetch);
    const made = await api.create("  Budgets ", null);
    expect(made.ok && made.data).toMatchObject({ name: "Budgets", parentId: null, threads: 0 });
    const id = made.ok ? made.data.id : "";
    const sub = await api.create("Q1", id);
    expect(sub.ok && sub.data.parentId).toBe(id);
    const taken = await api.create("budgets", null);
    expect(!taken.ok && taken.error.code).toBe("folder_name_taken");
    const t = fake.addThread("Plan");
    const filed = await api.file(t, id);
    expect(filed.ok && filed.data.folderId).toBe(id);
    const listed = await api.list();
    expect(listed.ok && listed.data.map((f) => [f.name, f.threads])).toEqual([
      ["Budgets", 1],
      ["Q1", 0],
    ]);
    const renamed = await api.update(id, { name: "Money" });
    expect(renamed.ok && renamed.data.name).toBe("Money");
    expect((await api.remove(id)).ok).toBe(true);
    expect(fake.threads.get(t)?.folder_id).toBeNull();
    expect(fake.requests.at(-1)).toMatchObject({ method: "DELETE", team: fake.teamId });
  });

  it("refuses an empty name before asking, and a malformed answer", async () => {
    const fake = new FakeKobe();
    const api = createFoldersApi(fake.teamId, fake.fetch);
    const empty = await api.create("   ", null);
    expect(!empty.ok && empty.error.code).toBe("invalid_request");
    expect(fake.requests).toHaveLength(0);
    const bad = createFoldersApi(fake.teamId, async () =>
      Response.json({ folders: [{ id: "x", name: "<b>" }] }),
    );
    const res = await bad.list();
    expect(!res.ok && res.error.code).toBe("malformed_response");
  });
});
