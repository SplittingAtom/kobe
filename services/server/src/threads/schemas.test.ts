import { describe, expect, it } from "vitest";
import { threadStatus } from "@kobe/db";
import { THREAD_STATUSES } from "@kobe/protocol";
import {
  ENTRY_PAGE_DEFAULT,
  THREAD_PAGE_DEFAULT,
  createThreadBodySchema,
  entriesQuerySchema,
  listThreadsQuerySchema,
  setLeafBodySchema,
  updateThreadBodySchema,
  uuidSchema,
} from "./schemas.js";

const ID = "0F8FAD5B-D9CB-469F-A165-70867728950E";

describe("thread API schemas", () => {
  it("uses the same thread statuses as the database and @kobe/protocol", () => {
    expect([...threadStatus.enumValues]).toEqual([...THREAD_STATUSES]);
  });

  it("normalizes uuids to lowercase", () => {
    expect(uuidSchema.parse(ID)).toBe(ID.toLowerCase());
  });

  it("accepts a minimal create body and rejects unknown keys and bad ids", () => {
    expect(createThreadBodySchema.parse({})).toEqual({});
    expect(createThreadBodySchema.parse({ agent_id: null, title: "  Q3 plan " })).toEqual({
      agent_id: null,
      title: "Q3 plan",
    });
    expect(createThreadBodySchema.safeParse({ team_id: ID }).success).toBe(false);
    expect(createThreadBodySchema.safeParse({ owner_user_id: ID }).success).toBe(false);
    expect(createThreadBodySchema.safeParse({ agent_id: "default" }).success).toBe(false);
    expect(createThreadBodySchema.safeParse({ title: "" }).success).toBe(false);
    expect(createThreadBodySchema.safeParse({ title: "x".repeat(201) }).success).toBe(false);
    expect(createThreadBodySchema.safeParse({ title: "a\u0000b" }).success).toBe(false);
  });

  it("requires something to change on update", () => {
    expect(updateThreadBodySchema.safeParse({}).success).toBe(false);
    expect(updateThreadBodySchema.parse({ title: null })).toEqual({ title: null });
    expect(updateThreadBodySchema.parse({ shared_to_project: true })).toEqual({
      shared_to_project: true,
    });
    expect(updateThreadBodySchema.safeParse({ shared_to_project: "yes" }).success).toBe(false);
    expect(updateThreadBodySchema.safeParse({ deleted_at: null }).success).toBe(false);
  });

  it("validates Pi entry ids", () => {
    expect(setLeafBodySchema.parse({ entry_id: "a1b2c3d4" })).toEqual({ entry_id: "a1b2c3d4" });
    expect(setLeafBodySchema.safeParse({ entry_id: "" }).success).toBe(false);
    expect(setLeafBodySchema.safeParse({ entry_id: "x".repeat(129) }).success).toBe(false);
    expect(setLeafBodySchema.safeParse({ entry_id: "a\nb" }).success).toBe(false);
  });

  it("parses list and entry query strings with defaults and bounds", () => {
    expect(listThreadsQuerySchema.parse({})).toEqual({ limit: THREAD_PAGE_DEFAULT });
    expect(listThreadsQuerySchema.parse({ limit: "100", project_id: ID })).toEqual({
      limit: 100,
      project_id: ID.toLowerCase(),
    });
    for (const limit of ["0", "101", "-1", "1.5", "abc", "01"]) {
      expect(listThreadsQuerySchema.safeParse({ limit }).success, limit).toBe(false);
    }
    expect(listThreadsQuerySchema.safeParse({ q: "   " }).success).toBe(false);
    expect(listThreadsQuerySchema.safeParse({ team_id: ID }).success).toBe(false);
    expect(entriesQuerySchema.parse({})).toEqual({ after: 0, limit: ENTRY_PAGE_DEFAULT });
    expect(entriesQuerySchema.parse({ after: "42", limit: "500" })).toEqual({
      after: 42,
      limit: 500,
    });
    expect(entriesQuerySchema.safeParse({ limit: "501" }).success).toBe(false);
    expect(entriesQuerySchema.safeParse({ after: "-1" }).success).toBe(false);
    expect(entriesQuerySchema.safeParse({ after: "99999999999" }).success).toBe(false);
  });
});
