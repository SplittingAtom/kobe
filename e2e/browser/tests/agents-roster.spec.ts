import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { Chat } from "./support/chat.js";
import { SHELL_TIMEOUT_MS } from "./support/constants.js";
import { secondBrowser } from "./support/gate5.js";
import { panelOf } from "./support/panel.js";

/**
 * KOBE-572 (agents-roster AR-8): the Agents page's Personal, Team and Site rosters on gate1 with
 * the owner (KOBE_USER: site Owner and Team1 admin) and member2 (KOBE_USER2/KOBE_PW2, a plain
 * member). Five self-contained scenarios; each creates its agents through the API and the
 * afterEach withdraws their entries, deletes the agents, schedules and threads it made. The team
 * default agent is never changed. Only "assign and run" spends a model turn. Skipped when the
 * deployment has no roster API. Run on gate1: `npx playwright test agents-roster`.
 */
const USER2 = process.env["KOBE_USER2"];
const PW2 = process.env["KOBE_PW2"];
const TEAM_KEY = "kobe.lastTeamId";

interface Agent {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}
interface Row {
  agentId: string;
  status: string;
  versionInEffect: number | null;
  currentVersion: number | null;
}

/** A JSON call from the page (session cookie, the active team), optionally with If-Match. */
async function call<T = Record<string, unknown>>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
  ifMatch?: string,
): Promise<{ status: number; json: T }> {
  return page.evaluate(
    async ({ method, path, body, ifMatch, teamKey }) => {
      const headers: Record<string, string> = {};
      const team = window.localStorage.getItem(teamKey);
      if (team) headers["x-kobe-team"] = team;
      if (ifMatch) headers["if-match"] = ifMatch;
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await fetch(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      let json: unknown = {};
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON (204)
      }
      return { status: res.status, json: json as T };
    },
    { method, path, body, ifMatch, teamKey: TEAM_KEY },
  );
}

/** Undo steps for the running test, run last-in first-out by afterEach (failures only logged). */
let cleanups: (() => Promise<unknown>)[] = [];
const later = (step: () => Promise<unknown>): void => void cleanups.push(step);

const stamp = (): string => Date.now().toString(36);
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Creates an agent (personal or team-owned) and schedules its clean-up: withdraw, then delete. */
async function createAgent(page: Page, scope: "personal" | "team", name: string): Promise<Agent> {
  const r = await call<{ agent: Agent }>(page, "POST", "/v1/agents", {
    scope,
    frontmatter: { name, description: "KOBE-572 roster spec" },
    prompt: "You answer in one short sentence.",
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const agent = { id: r.json.agent.id, slug: r.json.agent.slug, name };
  later(() => call(page, "DELETE", `/v1/agents/${agent.id}`));
  if (scope === "personal") {
    later(() => call(page, "DELETE", `/v1/agents/${agent.id}/assignments/site`));
    later(() => call(page, "DELETE", `/v1/agents/${agent.id}/assignments/team`));
  }
  return agent;
}

/** Publishes the draft as the next version (skips where the team's eval gate holds publishes). */
async function publish(page: Page, agent: Agent, prompt?: string): Promise<void> {
  if (prompt !== undefined) {
    const put = await call(
      page,
      "PUT",
      `/v1/agents/${agent.id}`,
      { frontmatter: { name: agent.name, description: "KOBE-572 roster spec" }, prompt },
      "*",
    );
    expect(put.status, JSON.stringify(put.json)).toBe(200);
  }
  const r = await call(page, "POST", `/v1/agents/${agent.id}/publish`, undefined, "*");
  test.skip(r.status === 202, "the team's pre-publish eval gate is on");
  expect(r.status, JSON.stringify(r.json)).toBe(201);
}

async function assign(page: Page, agent: Agent, target: "team" | "site", versionRule?: number) {
  return call<{ entry?: { state: string }; code?: string }>(
    page,
    "POST",
    `/v1/agents/${agent.id}/assignments`,
    versionRule === undefined ? { target } : { target, versionRule },
  );
}

/** The agent's row on a roster tab as the page's user reads it (all pages), or null. */
async function rosterRow(page: Page, tab: string, agentId: string): Promise<Row | null> {
  let cursor: string | null = null;
  do {
    const query: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const r = await call<{ rows: Row[]; nextCursor: string | null }>(
      page,
      "GET",
      `/v1/agents/roster?tab=${tab}${query}`,
    );
    expect(r.status).toBe(200);
    const row = r.json.rows.find((x) => x.agentId === agentId);
    if (row) return row;
    cursor = r.json.nextCursor;
  } while (cursor !== null);
  return null;
}

/** A thread the page's user starts with the agent (API); its clean-up is scheduled. */
async function startThread(page: Page, agent: Agent): Promise<string> {
  const r = await call<{ thread_id: string }>(page, "POST", "/v1/threads", { agent_id: agent.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  later(() => call(page, "DELETE", `/v1/threads/${r.json.thread_id}`));
  return r.json.thread_id;
}

async function threadPin(page: Page, threadId: string) {
  const r = await call<{ agent_id: string | null; agent_version: number | null }>(
    page,
    "GET",
    `/v1/threads/${threadId}`,
  );
  expect(r.status).toBe(200);
  return { agentId: r.json.agent_id, version: r.json.agent_version };
}

async function teamName(page: Page): Promise<string> {
  const r = await call<{ activeTeamId: string; teams: { id: string; name: string }[] }>(
    page,
    "GET",
    "/v1/me/teams",
  );
  return r.json.teams.find((t) => t.id === r.json.activeTeamId)?.name ?? "";
}

/** member2's own browser (a password sign-in), closed after the test's other clean-up. */
async function member(browser: Browser): Promise<Page> {
  test.skip(!USER2 || !PW2, "KOBE_USER2 and KOBE_PW2 name a second member");
  const page = await secondBrowser(browser, USER2, PW2);
  cleanups.unshift(() => page.context().close());
  return page;
}

/** The Agents page on a tab; returns that tab's panel (the other tabs stay mounted, hidden). */
async function openTab(page: Page, tab: "personal" | "team" | "site"): Promise<Locator> {
  await page.goto(`/agents?tab=${tab}`);
  const panel = panelOf(page);
  await expect(panel.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  const label = { personal: "Personal", team: "Team", site: "Site" }[tab];
  await expect(panel.getByRole("tab", { name: label, exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  return panel.getByRole("tabpanel");
}

const rowOf = (tab: Locator, agent: Agent): Locator =>
  tab.locator(`tr[data-agent="${agent.slug}"]`);

async function rowAction(page: Page, row: Locator, agent: Agent, item: string): Promise<void> {
  await expect(row).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await row.getByRole("button", { name: `Actions for ${agent.name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  cleanups = [];
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  const probe = await call(page, "GET", "/v1/agents/roster?tab=personal");
  test.skip(probe.status === 404, "this deployment has no agent roster API (KOBE-566)");
});

test.afterEach(async () => {
  for (const step of cleanups.reverse()) {
    await step().catch((e: unknown) => console.warn(`clean-up step failed: ${String(e)}`));
  }
  cleanups = [];
});

test("assign and run: member2 starts the owner's assigned agent from the picker", async ({
  page,
  browser,
}) => {
  const agent = await createAgent(page, "personal", `Roster run ${stamp()}`);
  await publish(page, agent);
  const assigned = await assign(page, agent, "team");
  expect(assigned.status).toBe(201);
  expect(assigned.json.entry?.state).toBe("active");

  const other = await member(browser);
  const team = await openTab(other, "team");
  await expect(rowOf(team, agent)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  await expect(rowOf(team, agent)).toContainText("Active");
  const row = await rosterRow(other, "team", agent.id);
  expect(row?.versionInEffect).toBe(1);

  const chat = new Chat(other);
  later(() => chat.trashAll());
  await chat.open();
  await (await chat.selectors()).getByRole("button", { name: /^Chat with:/ }).click();
  const picker = other.getByRole("radiogroup", { name: "Chat with" });
  const radio = picker
    .getByRole("group", { name: "Team", exact: true })
    .getByRole("radio", { name: new RegExp(`^${escapeRegExp(agent.name)}`) });
  await picker.locator("label").filter({ has: radio }).click();
  await expect(radio).toBeChecked();
  await other.keyboard.press("Escape");
  const threadId = await chat.ask("No tools. Reply with the single word ROSTER.");
  await expect(chat.answers.last()).not.toBeEmpty();
  expect(await threadPin(other, threadId)).toEqual({ agentId: agent.id, version: 1 });
});

test("propose and approve: member2 proposes, the owner approves with a pin to v1", async ({
  page,
  browser,
}) => {
  const other = await member(browser);
  const teamLabel = await teamName(other);
  const agent = await createAgent(other, "personal", `Roster propose ${stamp()}`);
  await publish(other, agent);

  const personal = await openTab(other, "personal");
  const proposed = other.waitForResponse(
    (r) =>
      r.url().endsWith(`/v1/agents/${agent.id}/assignments`) && r.request().method() === "POST",
  );
  await rowAction(other, rowOf(personal, agent), agent, `Propose to ${teamLabel}`);
  expect((await proposed).status()).toBe(202);
  await expect(rowOf(personal, agent)).toContainText(`Proposed to ${teamLabel}`);

  const team = await openTab(page, "team");
  const queue = team.getByRole("button", { name: /^Proposed \(\d+\)$/ });
  await expect(queue).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  // Other runs may have left proposals behind: at least this one is waiting.
  expect(Number((await queue.textContent())?.match(/\d+/)?.[0] ?? 0)).toBeGreaterThanOrEqual(1);
  await queue.click();
  await expect(queue).toHaveAttribute("aria-pressed", "true");
  await rowAction(page, rowOf(team, agent), agent, "Approve…");
  const dialog = page.getByRole("dialog", { name: `Approve ${agent.name} for ${teamLabel}?` });
  await dialog.getByLabel("Version rule").selectOption("1");
  await dialog.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await rosterRow(page, "team", agent.id))?.status).toBe("active");

  const mine = await openTab(other, "team");
  await expect(rowOf(mine, agent)).toContainText("Active", { timeout: SHELL_TIMEOUT_MS });
  await expect(rowOf(mine, agent)).toContainText("v1");
  const reach = await openTab(other, "personal");
  await expect(rowOf(reach, agent)).toContainText(`Team: ${teamLabel}`);
});

// Deviation: the owner forks, not member2: members may not fork team content at all (403, KOBE-568
// `canForkAgent`), so the bound fork needs a builder or team admin.
test("fork bound: a fork of a team-owned agent lands in Personal, bound, refused for the site", async ({
  page,
}) => {
  const teamLabel = await teamName(page);
  const source = await createAgent(page, "team", `Roster team ${stamp()}`);
  await publish(page, source);

  const team = await openTab(page, "team");
  await rowAction(page, rowOf(team, source), source, "Fork to Personal…");
  const dialog = page.getByRole("dialog", { name: `Fork ${source.name}` });
  await expect(dialog.getByRole("note")).toHaveText(
    `Bound to Team ${teamLabel}: usable only there.`,
  );
  const forked = page.waitForResponse(
    (r) => r.url().endsWith(`/v1/agents/${source.id}/fork`) && r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Fork and open", exact: true }).click();
  const res = await forked;
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { agent: Agent; boundTeamId: string | null };
  const copy: Agent = { id: body.agent.id, slug: body.agent.slug, name: body.agent.name };
  later(() => call(page, "DELETE", `/v1/agents/${copy.id}`));
  expect(body.boundTeamId).not.toBeNull();
  await page.waitForURL(`**/agents/${copy.id}`, { timeout: SHELL_TIMEOUT_MS });

  const personal = await openTab(page, "personal");
  await expect(rowOf(personal, copy)).toContainText(`Bound to Team: ${teamLabel}`, {
    timeout: SHELL_TIMEOUT_MS,
  });
  // AR8: refused whatever its version state (a bound agent is never assignable elsewhere).
  const refused = await assign(page, copy, "site");
  expect(refused.status).toBe(422);
  expect(refused.json.code).toBe("agent_bound_to_team");
});

test("pin and update: Update available, Update to latest, an earlier thread keeps v1", async ({
  page,
  browser,
}) => {
  const teamLabel = await teamName(page);
  const agent = await createAgent(page, "personal", `Roster pin ${stamp()}`);
  await publish(page, agent);
  expect((await assign(page, agent, "team")).status).toBe(201);

  // The owner, as team admin, pins the entry to v1 from the Team tab.
  let team = await openTab(page, "team");
  await rowAction(page, rowOf(team, agent), agent, "Pin a version…");
  const dialog = page.getByRole("dialog", { name: `Version of ${agent.name} on ${teamLabel}` });
  await dialog.getByLabel("Version rule").selectOption("1");
  await dialog.getByRole("button", { name: "Save version rule", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(rowOf(team, agent)).toContainText("Pinned to v1");

  const other = await member(browser);
  const before = await startThread(other, agent);
  expect((await threadPin(other, before)).version).toBe(1);

  // The owner publishes v2: the pinned entry is behind.
  await publish(page, agent, "You answer in one short sentence, version two.");
  team = await openTab(page, "team");
  await expect(rowOf(team, agent)).toContainText("Update available: v2", {
    timeout: SHELL_TIMEOUT_MS,
  });
  await rowAction(page, rowOf(team, agent), agent, "Update to latest (v2)");
  await expect.poll(async () => (await rosterRow(page, "team", agent.id))?.versionInEffect).toBe(2);
  await expect(rowOf(team, agent)).not.toContainText("Update available");
  await expect(rowOf(team, agent).getByRole("link", { name: /^v2/ })).toBeVisible();

  // D19: the earlier thread keeps its pin; a new one starts on the version in effect.
  expect(await threadPin(other, before)).toEqual({ agentId: agent.id, version: 1 });
  expect((await threadPin(other, await startThread(other, agent))).version).toBe(2);
});

// The literal "owner leaves" case needs a disposable member (member2 is shared by other specs):
// withdrawing the entry exercises the same pause/resume and pin rules (see the KOBE-572 ledger).
test("withdraw pauses schedules; threads keep pins", async ({ page, browser }) => {
  const agent = await createAgent(page, "personal", `Roster withdraw ${stamp()}`);
  await publish(page, agent);
  expect((await assign(page, agent, "team")).status).toBe(201);

  const other = await member(browser);
  const thread = await startThread(other, agent);
  const prompt = `KOBE-572 roster schedule ${stamp()}`;
  const created = await call<{ schedule_id: string }>(other, "POST", "/v1/schedules", {
    agent_id: agent.id,
    prompt,
    recurrence: { kind: "weekly", days: ["sun"], at: "03:00" },
    tz: "UTC",
    active: true,
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const scheduleId = created.json.schedule_id;
  later(() => call(other, "DELETE", `/v1/schedules/${scheduleId}`));
  const schedule = async () =>
    (
      await call<{ active: boolean; paused_by: string | null }>(
        other,
        "GET",
        `/v1/schedules/${scheduleId}`,
      )
    ).json;

  const withdrawn = await call(page, "DELETE", `/v1/agents/${agent.id}/assignments/team`);
  expect(withdrawn.status).toBe(200);

  expect(await threadPin(other, thread)).toEqual({ agentId: agent.id, version: 1 });
  const team = await openTab(other, "team");
  await expect(
    team
      .getByRole("table")
      .or(team.getByText(/Nothing/))
      .first(),
  ).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect(rowOf(team, agent)).toHaveCount(0);
  expect(await schedule()).toMatchObject({ active: false, paused_by: "agent_unavailable" });
  await other.goto("/me/schedules");
  const line = panelOf(other).getByRole("row").filter({ hasText: prompt });
  await expect(line).toContainText("Paused: agent unavailable", { timeout: SHELL_TIMEOUT_MS });

  expect((await assign(page, agent, "team")).status).toBe(201);
  await expect.poll(schedule).toMatchObject({ active: true, paused_by: null });
  await other.reload();
  await expect(line).toContainText("Active", { timeout: SHELL_TIMEOUT_MS });
});
