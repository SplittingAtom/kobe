import { MEMORY_NOTIFICATION_KINDS } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import type { KobeNotification } from "./api";
import { notificationLabel, notificationTitle } from "./format";
import { memoryNotificationLink } from "./memory";

const base: KobeNotification = {
  notificationId: "n",
  kind: "memory.proposal.received",
  scheduleId: null,
  threadId: null,
  runId: null,
  memoryObjectId: "obj-1",
  readAt: null,
  createdAt: "2026-11-13T08:00:00Z",
};

/** One example of every memory kind, with the fields it names. */
const examples: Record<(typeof MEMORY_NOTIFICATION_KINDS)[number], KobeNotification> = {
  "memory.scope.near_full": {
    ...base,
    kind: "memory.scope.near_full",
    memoryObjectId: undefined,
    memoryScope: "team",
  },
  "memory.review.reminder": { ...base, kind: "memory.review.reminder" },
  "memory.review.candidates_ready": {
    ...base,
    kind: "memory.review.candidates_ready",
    threadId: "t-1",
    itemCount: 3,
  },
  "memory.proposal.changes_requested": { ...base, kind: "memory.proposal.changes_requested" },
  "memory.proposal.expired": { ...base, kind: "memory.proposal.expired" },
  "memory.suggestion.expired": { ...base, kind: "memory.suggestion.expired", projectId: "p-1" },
  "memory.site_proposal.confirmed": { ...base, kind: "memory.site_proposal.confirmed" },
  "memory.site_proposal.changes_requested": {
    ...base,
    kind: "memory.site_proposal.changes_requested",
  },
  "memory.site_proposal.expired": { ...base, kind: "memory.site_proposal.expired" },
  "memory.review.digest": {
    ...base,
    kind: "memory.review.digest",
    memoryObjectId: undefined,
    relatedKind: "memory.proposal.received",
    itemCount: 4,
  },
  "memory.proposal.received": { ...base, actorName: "Ann" },
  "memory.proposal.accepted": { ...base, kind: "memory.proposal.accepted", actorName: "Cat" },
  "memory.proposal.dismissed": { ...base, kind: "memory.proposal.dismissed" },
  "memory.suggestion.received": {
    ...base,
    kind: "memory.suggestion.received",
    projectId: "p-1",
    actorName: "Rae",
  },
  "memory.suggestion.accepted": { ...base, kind: "memory.suggestion.accepted", projectId: "p-1" },
  "memory.suggestion.dismissed": { ...base, kind: "memory.suggestion.dismissed", projectId: "p-1" },
  "memory.site_proposal.received": { ...base, kind: "memory.site_proposal.received" },
  "memory.site_proposal.accepted": { ...base, kind: "memory.site_proposal.accepted" },
  "memory.site_proposal.dismissed": { ...base, kind: "memory.site_proposal.dismissed" },
};

describe("memory notifications in the bell (KOBE-645)", () => {
  it.each(MEMORY_NOTIFICATION_KINDS)("%s has words, a label and a deep link", (kind) => {
    const n = examples[kind];
    expect(notificationTitle(n)).toMatch(/\w/);
    expect(notificationLabel(n, null)).toMatch(/memory|notes/i);
    const link = memoryNotificationLink(n);
    if (kind === "memory.review.candidates_ready") {
      // Opens its conversation (the bell's Open conversation), where To review lives.
      expect(n.threadId).toBeTruthy();
      expect(link).toBeNull();
      return;
    }
    expect(link?.href).toMatch(/^\/(me|admin)\//);
    expect(link?.label).toMatch(/^Open /);
  });

  it("names who acted and what", () => {
    expect(notificationTitle(examples["memory.proposal.received"])).toBe(
      "Ann proposed a Workspace memory",
    );
    expect(notificationTitle(examples["memory.proposal.accepted"])).toBe(
      "Cat accepted your Workspace memory proposal",
    );
    expect(notificationTitle(examples["memory.suggestion.received"])).toBe(
      "Rae suggested a project note",
    );
    expect(notificationTitle(examples["memory.scope.near_full"])).toBe(
      "Workspace memory is 80% full",
    );
    expect(notificationTitle({ ...examples["memory.scope.near_full"], memoryScope: "site" })).toBe(
      "Site memory is 80% full",
    );
    expect(notificationTitle(examples["memory.review.candidates_ready"])).toBe(
      "3 memories to review",
    );
    expect(notificationTitle(examples["memory.review.digest"])).toBe(
      "4 more Workspace memory proposals in the last hour",
    );
  });

  it("links each kind to where the person decides or sees the result", () => {
    const href = (n: KobeNotification) => memoryNotificationLink(n)?.href;
    expect(href(examples["memory.proposal.received"])).toBe("/admin/team/memory?proposal=obj-1");
    expect(href(examples["memory.proposal.accepted"])).toBe("/me/memory?proposal=obj-1");
    expect(href(examples["memory.suggestion.received"])).toBe("/me/projects/p-1?suggestion=obj-1");
    expect(href(examples["memory.scope.near_full"])).toBe("/admin/team/memory");
    // A digest opens the list of what it rolled up; a reminder opens its object.
    expect(href(examples["memory.review.digest"])).toBe("/admin/team/memory");
    expect(href(examples["memory.review.reminder"])).toBe("/me/memory?review=obj-1");
    expect(
      href({
        ...examples["memory.review.reminder"],
        relatedKind: "memory.site_proposal.received",
      }),
    ).toBe("/admin/site/memory?site_proposal=obj-1");
    expect(href(examples["memory.site_proposal.confirmed"])).toBe(
      "/admin/site/memory?site_proposal=obj-1",
    );
    expect(href(examples["memory.site_proposal.changes_requested"])).toBe(
      "/admin/team/memory?site_proposal=obj-1",
    );
    expect(
      href({
        ...examples["memory.review.reminder"],
        relatedKind: "memory.suggestion.received",
        projectId: "p-2",
      }),
    ).toBe("/me/projects/p-2?suggestion=obj-1");
  });

  it("has no link for other kinds", () => {
    expect(
      memoryNotificationLink({ ...base, kind: "schedule.run.failed", scheduleId: "s" }),
    ).toBeNull();
  });
});
