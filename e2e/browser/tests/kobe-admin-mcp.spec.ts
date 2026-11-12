import type { Locator, Page } from "@playwright/test";
import { Chat, expect, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS, SHELL_TIMEOUT_MS } from "./support/constants.js";
import { pageApi, secondBrowser } from "./support/gate5.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-624 (KA-7; spec docs/specs/kobe-admin-mcp.md): admin and docs from the conversation through
 * the built-in Kobe connector.
 *
 * - `KOBE_USER` / `KOBE_PW`: a site admin who is also team admin of the active team (`KOBE_TEAM`
 *   pins it). Its default agent must name the `kobe` connector or `connectors: all` (the gallery
 *   agent Kobe does), else the admin tools are not attached.
 * - `KOBE_USER2` / `KOBE_PW2`: an ordinary member of that team (role `member`).
 *
 * Each test sets the site switch (`kobe_mcp.mode`) and the team's Kobe level through the console
 * API, and puts both back as it found them in `finally`.
 *
 * (a) the owner asks the agent to make member2 a contributor: an "Admin change" card (scope the
 * team, a summary naming member2, role member → contributor, no remember controls, no "Approve
 * all"); allowed, the role is changed, and the team audit shows the event "via agent" with a link
 * to the thread; member2 is put back to member. (b) member2 asks the same: no admin tool is offered
 * (no `mcp__kobe__` admin call in the thread). (c) a how-to question is answered with the docs
 * tools and cites a `/docs/` page, with no network fetch of the guide. (d) with the team at "docs
 * only", the owner's role change gets no admin tool either.
 */
const USER2 = process.env["KOBE_USER2"];
const PW2 = process.env["KOBE_PW2"];

type Mode = "off" | "docs" | "admin";
type Level = "docs" | "read" | "read_write";
type Role = "team_admin" | "contributor" | "member";

interface Member {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: Role;
}

interface ToolCall {
  readonly name: string;
  readonly args: string;
}

/** A Kobe connector tool's Pi name: `mcp__kobe__<tool>` (or the fallback name `kobe-builtin`). */
const KOBE_TOOL = /^mcp__kobe(?:[-_]builtin)?__(.+)$/;
const isKobeAdminCall = (c: ToolCall): boolean => {
  const tool = KOBE_TOOL.exec(c.name)?.[1];
  return tool !== undefined && !tool.startsWith("docs_");
};
const isKobeDocsCall = (c: ToolCall): boolean =>
  /^docs_(index|page|search|full)$/.test(KOBE_TOOL.exec(c.name)?.[1] ?? "");

async function siteMode(page: Page): Promise<Mode> {
  const res = await pageApi<{ kobeMcpMode?: Mode }>(page, "GET", "/v1/site/settings");
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  expect(res.json.kobeMcpMode, "the server predates the Kobe site switch").toBeDefined();
  return res.json.kobeMcpMode as Mode;
}

async function setSiteMode(page: Page, mode: Mode): Promise<void> {
  const res = await pageApi(page, "PUT", "/v1/site/settings", { kobeMcpMode: mode });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

async function teamLevel(page: Page): Promise<Level> {
  const res = await pageApi<{ kobe?: { level: Level } }>(page, "GET", "/v1/team/connectors/kobe");
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.kobe?.level ?? "docs";
}

async function setTeamLevel(page: Page, level: Level): Promise<void> {
  const res = await pageApi(page, "PUT", "/v1/team/connectors/kobe", { level });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

/**
 * Runs `body` with the site switch and the team level set as asked, then puts back what it found
 * (each step on its own, so one failing does not skip the other).
 */
async function withSwitches(
  page: Page,
  want: { readonly mode: Mode; readonly level: Level },
  body: () => Promise<void>,
): Promise<void> {
  const before = { mode: await siteMode(page), level: await teamLevel(page) };
  try {
    await setSiteMode(page, want.mode);
    await setTeamLevel(page, want.level);
    await body();
  } finally {
    await setTeamLevel(page, before.level).catch((e: unknown) =>
      console.warn(`could not restore the team's Kobe level: ${String(e)}`),
    );
    await setSiteMode(page, before.mode).catch((e: unknown) =>
      console.warn(`could not restore the Kobe site switch: ${String(e)}`),
    );
  }
}

/** The admin tools the page's member would get now (the composer's Kobe row). */
async function kobeAdmin(page: Page): Promise<string | undefined> {
  const res = await pageApi<{ connectors?: { builtin?: { admin: string } }[] }>(
    page,
    "GET",
    "/v1/threads/connectors",
  );
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return (res.json.connectors ?? []).find((c) => c.builtin !== undefined)?.builtin?.admin;
}

async function members(page: Page): Promise<Member[]> {
  const res = await pageApi<{ members?: Member[] }>(page, "GET", "/v1/team/members");
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.members ?? [];
}

async function memberByEmail(page: Page, email: string): Promise<Member> {
  const found = (await members(page)).find((m) => m.email.toLowerCase() === email.toLowerCase());
  expect(found, `${email} is a member of the active team`).toBeDefined();
  return found as Member;
}

async function setRole(page: Page, userId: string, role: Role): Promise<void> {
  const res = await pageApi(page, "PATCH", `/v1/team/members/${encodeURIComponent(userId)}`, {
    role,
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
}

/** Every tool call of the thread (assistant `toolCall` parts), read page by page. */
async function toolCalls(page: Page, threadId: string): Promise<ToolCall[]> {
  const calls: ToolCall[] = [];
  let after = 0;
  for (let n = 0; n < 100; n += 1) {
    const res = await pageApi<{
      entries?: { payload?: { message?: { content?: unknown } } }[];
      next_entries_after?: number | string | null;
    }>(page, "GET", `/v1/threads/${encodeURIComponent(threadId)}/entries?after=${after}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    for (const entry of res.json.entries ?? []) {
      const content = entry.payload?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content as Record<string, unknown>[]) {
        if (part?.["type"] !== "toolCall" || typeof part["name"] !== "string") continue;
        calls.push({ name: part["name"], args: JSON.stringify(part["arguments"] ?? {}) });
      }
    }
    const next = Number(res.json.next_entries_after ?? NaN);
    if (!Number.isFinite(next) || next <= after) break;
    after = next;
  }
  return calls;
}

/** The answer's text with its links' targets, so a cited page counts as text or as a link. */
async function answerText(answer: Locator): Promise<string> {
  return answer.evaluate((el) => {
    const hrefs = [...el.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
    return `${(el as HTMLElement).innerText}\n${hrefs.join("\n")}`;
  });
}

const ADMIN_CARD = /Admin change/;

test("the owner changes member2's role from the conversation: Admin change card, approved, audited via agent", async ({
  chat,
  page,
}) => {
  test.skip(!USER2 || !PW2, "KOBE_USER2 and KOBE_PW2 name a second member");
  test.setTimeout(3 * RUN_TIMEOUT_MS);
  await chat.open();
  const target = await memberByEmail(page, USER2 as string);
  expect(target.role, "member2 starts as a member").toBe("member");
  const team = await pageApi<{ team?: { name: string } }>(page, "GET", "/v1/team");
  const teamName = team.json.team?.name ?? "";

  await withSwitches(page, { mode: "admin", level: "read_write" }, async () => {
    try {
      expect(await kobeAdmin(page)).toBe("read_write");
      await chat.send(
        `Use the Kobe admin tools to change the team role of ${target.name} (${target.email}) ` +
          "from member to contributor. First list the team members to find their user id, then " +
          "call the role change tool exactly once. Then reply DONE.",
      );
      const card = page.getByRole("group", { name: ADMIN_CARD }).last();
      await expect(card).toBeVisible({ timeout: RUN_TIMEOUT_MS });
      await expect(card).toContainText(`Scope: Team ${teamName}`);
      await expect(card.getByLabel("Change summary")).toContainText(target.name);
      await expect(card.getByLabel("Change summary")).toContainText("Member → Contributor");
      const role = card.getByRole("table", { name: "Before and after" }).getByRole("row", {
        name: /role/,
      });
      await expect(role).toContainText("member");
      await expect(role).toContainText("contributor");
      // Admin changes are never remembered and never approved with others.
      await expect(card.getByRole("checkbox", { name: /Remember/ })).toHaveCount(0);
      await expect(card.getByRole("button", { name: /Approve all waiting/ })).toHaveCount(0);
      await expect(card.getByRole("button", { name: "Allow", exact: true })).toBeEnabled();
      await card.getByRole("button", { name: "Allow", exact: true }).click();
      await chat.waitForIdle();
      const threadId = await chat.threadId();

      await expect
        .poll(async () => (await memberByEmail(page, target.email)).role, {
          timeout: SHELL_TIMEOUT_MS,
        })
        .toBe("contributor");
      const setRoleCalls = (await toolCalls(page, threadId)).filter((c) =>
        /__team_members_set_role$/.test(c.name),
      );
      expect(setRoleCalls.length).toBeGreaterThanOrEqual(1);

      // The team audit: the console's own event, the owner "via agent", linked to this thread.
      const audit = await pageApi<{
        events?: { action: string; viaAgent?: { threadId: string; runId: string } }[];
      }>(page, "GET", "/v1/team/audit?action=identity.member.role_changed&limit=20");
      expect(audit.status, JSON.stringify(audit.json)).toBe(200);
      const event = (audit.json.events ?? []).find((e) => e.viaAgent?.threadId === threadId);
      expect(event, "a role_changed event via agent for this thread").toBeDefined();
      await page.goto("/admin/team/audit");
      const via = panelOf(page)
        .locator("[data-kobe-via-agent]")
        .filter({ hasText: event?.viaAgent?.runId ?? "" });
      await expect(via.first()).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
      await expect(via.first()).toContainText("via agent");
      await expect(via.first().getByRole("link", { name: "open the thread" })).toHaveAttribute(
        "href",
        `/?thread=${threadId}`,
      );
    } finally {
      const now = (await members(page)).find((m) => m.userId === target.userId);
      if (now !== undefined && now.role !== "member") await setRole(page, target.userId, "member");
    }
  });
});

test("member2 gets no admin tool: the agent answers without one", async ({ page, browser }) => {
  test.skip(!USER2 || !PW2, "KOBE_USER2 and KOBE_PW2 name a second member");
  test.setTimeout(2 * RUN_TIMEOUT_MS);
  await new Chat(page).open();
  const owner = await memberByEmail(page, process.env["KOBE_USER"] ?? "");

  await withSwitches(page, { mode: "admin", level: "read_write" }, async () => {
    const other = await secondBrowser(browser, USER2, PW2);
    const otherChat = new Chat(other);
    try {
      expect(await kobeAdmin(other)).toBe("off");
      await otherChat.open();
      const threadId = await otherChat.ask(
        "Use the Kobe admin tools to list this team's members and change the role of " +
          `${owner.email} to member. If you have no such tool, say so and do not try another way.`,
      );
      await expect(other.getByRole("group", { name: ADMIN_CARD })).toHaveCount(0);
      const calls = await toolCalls(other, threadId);
      expect(calls.filter(isKobeAdminCall), JSON.stringify(calls)).toEqual([]);
      expect((await memberByEmail(page, owner.email)).role).toBe(owner.role);
    } finally {
      await otherChat.trashAll();
      await other.context().close();
    }
  });
});

test("a how-to question is answered from the docs tools and cites a /docs/ page", async ({
  chat,
  page,
}) => {
  test.setTimeout(2 * RUN_TIMEOUT_MS);
  await chat.open();
  // The docs tools need only the site switch on (docs is the default): no team level, no egress.
  const mode = await siteMode(page);
  await withSwitches(
    page,
    { mode: mode === "off" ? "docs" : mode, level: await teamLevel(page) },
    async () => {
      const threadId = await chat.ask(
        "How do I approve a team skill? Use the Kobe docs tools (docs_index, docs_search or " +
          "docs_page) to find the answer, and cite the guide page's /docs/ URL in your answer.",
      );
      const calls = await toolCalls(page, threadId);
      expect(calls.some(isKobeDocsCall), JSON.stringify(calls)).toBe(true);
      // The guide came through the connector, not over the network.
      const fetched = calls.filter(
        (c) => !KOBE_TOOL.test(c.name) && /llms(-full)?\.txt|\/docs\//.test(c.args),
      );
      expect(fetched, JSON.stringify(fetched)).toEqual([]);
      expect(await answerText(chat.answers.last())).toMatch(/\/docs\/[a-z0-9-]+/);
    },
  );
});

test("with the team at docs only, the owner's role change gets no admin tool", async ({
  chat,
  page,
}) => {
  test.skip(!USER2 || !PW2, "KOBE_USER2 and KOBE_PW2 name a second member");
  test.setTimeout(2 * RUN_TIMEOUT_MS);
  await chat.open();
  const target = await memberByEmail(page, USER2 as string);

  await withSwitches(page, { mode: "admin", level: "docs" }, async () => {
    try {
      expect(await kobeAdmin(page)).toBe("off");
      const threadId = await chat.ask(
        `Use the Kobe admin tools to change the team role of ${target.name} (${target.email}) ` +
          "to contributor. If you have no such tool, say so and do not try another way.",
      );
      await expect(page.getByRole("group", { name: ADMIN_CARD })).toHaveCount(0);
      const calls = await toolCalls(page, threadId);
      expect(calls.filter(isKobeAdminCall), JSON.stringify(calls)).toEqual([]);
      expect((await memberByEmail(page, target.email)).role).toBe(target.role);
    } finally {
      const now = (await members(page)).find((m) => m.userId === target.userId);
      if (now !== undefined && now.role !== target.role)
        await setRole(page, target.userId, target.role);
    }
  });
});
