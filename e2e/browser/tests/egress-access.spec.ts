import type { Locator, Page } from "@playwright/test";
import { Chat, expect, test } from "./support/chat.js";
import { RUN_TIMEOUT_MS, SHELL_TIMEOUT_MS } from "./support/constants.js";
import { bashTurn, pageApi, secondBrowser } from "./support/gate5.js";

/**
 * KOBE-605 (egress access, EA-4; spec docs/specs/egress-access.md). Every host comes from the
 * environment, so nothing about a deployment is in the repository:
 *
 * - `KOBE_USER` / `KOBE_PW`: a site admin (Owner or Admin) who is also admin of the active team
 *   (`KOBE_TEAM` pins it); `KOBE_USER2` / `KOBE_PW2`: an ordinary member of that team.
 * - `KOBE_EGRESS_BLOCKED_HOST`: an external host name outside the site ceiling (no pattern of the
 *   ceiling covers it). (a)/(b) skip without it.
 * - `KOBE_EGRESS_INTERNAL_HOST`: a host served by the cluster's ingress that no ceiling pattern
 *   covers yet (gate1 has `egressProxy.clusterIngress` on). (c) skips without it.
 * - `KOBE_EGRESS_PRIVATE_HOST`: a host name that resolves to a private address that is NOT the
 *   cluster ingress. (d) skips without it.
 *
 * (a) member2 is blocked, sees "Request access to HOST" and the site-admins sentence, requests,
 * has no Approve; (b) the site admin approves with the exact host in the Site console, member2's
 * card shows the decision and the agent's retry reaches the host (its curl prints an HTTP code,
 * not 000) with no new notice; (c) the site admin puts the internal host in the ceiling and
 * enables it for the team (so the block is forbidden_address), approves from the card with
 * "Internal (same cluster)" and the retry reaches the host; (d) an allowlisted private-resolving
 * host stays blocked (the retry prints 000 again). In every case the first answer keeps its
 * blocked card after the retry (KOBE-605: cards outlive their run).
 *
 * The agent's curl goes through a bash tool turn (the fake model's `bash:` line with
 * KOBE_FAKE_MODEL=1). Each test first denies pending requests for its host left by an earlier run;
 * clean-up (finally) puts the host's ceiling row back as it was, removes the team enablement,
 * denies leftover requests and trashes threads. member2's approved request from an earlier run
 * does not answer a new block (KOBE-609), so the spec passes twice in a row.
 */
const USER2 = process.env["KOBE_USER2"];
const PW2 = process.env["KOBE_PW2"];
const BLOCKED_HOST = process.env["KOBE_EGRESS_BLOCKED_HOST"]?.trim().toLowerCase();
const INTERNAL_HOST = process.env["KOBE_EGRESS_INTERNAL_HOST"]?.trim().toLowerCase();
const PRIVATE_HOST = process.env["KOBE_EGRESS_PRIVATE_HOST"]?.trim().toLowerCase();

const DECISION_TIMEOUT_MS = 90_000;

interface CeilingEntry {
  readonly domain: string;
  readonly in_ceiling: boolean;
  readonly internal?: boolean;
}

interface SiteRequest {
  readonly id: string;
  readonly domain: string;
  readonly pattern: string;
  readonly team: { readonly id: string };
}

/**
 * The probe prints `kobe-605 <HTTP code>`: `000` when it never reached the host (the proxy refused
 * the tunnel). `-k`: the question is whether the proxy lets the sandbox reach the host, not its
 * certificate (a host on the cluster ingress often serves the ingress's default one).
 */
const curlTurn = (host: string): string =>
  bashTurn(`curl -sS -k -o /dev/null -m 20 -w 'kobe-605 %{http_code}' https://${host}/`);

const NOT_REACHED = "000";

/** Whether a ceiling pattern covers a host (`*.x` matches subdomains only). */
function covers(pattern: string, host: string): boolean {
  return pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : pattern === host;
}

async function ceiling(page: Page): Promise<CeilingEntry[]> {
  const res = await pageApi<{ domains?: CeilingEntry[] }>(page, "GET", "/v1/site/egress-ceiling");
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.domains ?? [];
}

async function requireUncovered(page: Page, host: string): Promise<void> {
  const hit = (await ceiling(page)).find((d) => d.in_ceiling && covers(d.domain, host));
  test.skip(hit !== undefined, `a ceiling pattern already covers the host (${hit?.domain ?? ""})`);
}

/** Puts a host in the ceiling and enables it for the active team (the forbidden_address set-up). */
async function allowlist(page: Page, host: string): Promise<void> {
  const add = await pageApi(page, "POST", "/v1/site/egress-ceiling", { domain: host });
  expect([200, 201], JSON.stringify(add.json)).toContain(add.status);
  const on = await pageApi(page, "PUT", `/v1/team/egress/domains/${encodeURIComponent(host)}`);
  expect([200, 201], JSON.stringify(on.json)).toContain(on.status);
}

/** Denies every pending request (any team) for `host`: leftovers of an earlier run, or this one's. */
async function settlePending(page: Page, host: string): Promise<void> {
  const list = await pageApi<{ requests?: SiteRequest[] }>(
    page,
    "GET",
    "/v1/site/egress-ceiling/requests?status=pending",
  );
  for (const r of list.json.requests ?? []) {
    if (!covers(r.pattern, host) && r.domain !== host) continue;
    await pageApi(page, "POST", `/v1/site/egress-ceiling/requests/${r.team.id}/${r.id}/decision`, {
      decision: "deny",
    });
  }
}

/**
 * The host's ceiling row before the scenario (`undefined`: none), read after pending leftovers of
 * an earlier run are settled, so a run starts from the same state whatever ran before (KOBE-609).
 */
async function prepare(page: Page, host: string): Promise<CeilingEntry | undefined> {
  await settlePending(page, host);
  await requireUncovered(page, host);
  return (await ceiling(page)).find((d) => d.domain === host);
}

/**
 * Undoes what a scenario did to `host`, back to the ceiling row it found (`before`), so the next
 * run is not skipped as "already covered"; every step tolerates "already gone".
 */
async function cleanUp(page: Page, host: string, before: CeilingEntry | undefined): Promise<void> {
  const path = `/v1/site/egress-ceiling/${encodeURIComponent(host)}`;
  const restore = { in_ceiling: before?.in_ceiling ?? false, internal: before?.internal ?? false };
  const steps: Array<() => Promise<unknown>> = [
    () => settlePending(page, host),
    () => pageApi(page, "DELETE", `/v1/team/egress/domains/${encodeURIComponent(host)}`),
    async () => {
      if (before !== undefined) return pageApi(page, "PUT", path, restore);
      const del = await pageApi(page, "DELETE", path);
      if (del.status === 409) await pageApi(page, "PUT", path, restore);
      return del;
    },
  ];
  for (const step of steps)
    await step().catch((e: unknown) => console.warn(`clean-up: ${String(e)}`));
}

const blockedNote = (page: Page, host: string): Locator =>
  page.getByRole("note").filter({ hasText: `Internet access to ${host} was blocked` });

async function waitBlocked(page: Page, host: string): Promise<Locator> {
  const note = blockedNote(page, host).first();
  await expect(note).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  return note;
}

/**
 * The HTTP code the curl of `answer` printed, from its tool card's output (opened if folded). The
 * card's input holds `%{http_code}`, never three digits, so only the output matches.
 */
async function curlCode(answer: Locator): Promise<string> {
  const card = answer.getByRole("region", { name: "Tool call bash" }).last();
  await expect(card).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
  const toggle = card.locator("button[aria-expanded]").first();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(card).toContainText(/kobe-605 \d{3}/, { timeout: SHELL_TIMEOUT_MS });
  return /kobe-605 (\d{3})/.exec((await card.textContent()) ?? "")?.[1] ?? "";
}

interface Retry {
  /** What the retry's curl printed (`000`: not reached). */
  readonly code: string;
  /** Blocked notices for the host on the whole page after the retry. */
  readonly notices: number;
}

/**
 * Sends the curl turn again, waits for its answer, and reads its curl's HTTP code and the page's
 * blocked notices for the host. The first answer must still show its own notice (KOBE-605: a
 * card outlives its run). A retry blocked again within the proxy's report window (30 s per
 * sandbox and host) makes no new notice, so the HTTP code is what says whether it got through.
 */
async function retry(chat: Chat, host: string): Promise<Retry> {
  const before = await chat.answers.count();
  await chat.send(curlTurn(host));
  await expect
    .poll(() => chat.answers.count(), { timeout: RUN_TIMEOUT_MS, intervals: [1_000] })
    .toBeGreaterThan(before);
  await chat.waitForIdle();
  await expect(
    chat.answers
      .first()
      .getByRole("note")
      .filter({ hasText: `Internet access to ${host} was blocked` }),
  ).toHaveCount(1, { timeout: SHELL_TIMEOUT_MS });
  return {
    code: await curlCode(chat.answers.last()),
    notices: await blockedNote(chat.page, host).count(),
  };
}

test("member2 is blocked off the ceiling, requests; the site admin approves; the retry is not blocked", async ({
  page,
  browser,
}) => {
  test.skip(!BLOCKED_HOST, "KOBE_EGRESS_BLOCKED_HOST names an external host outside the ceiling");
  test.skip(!USER2 || !PW2, "KOBE_USER2 and KOBE_PW2 name a second member");
  const host = BLOCKED_HOST as string;
  await new Chat(page).open();
  const before = await prepare(page, host);
  const other = await secondBrowser(browser, USER2, PW2);
  const otherChat = new Chat(other);
  try {
    await otherChat.open();
    await otherChat.ask(curlTurn(host));

    // (a) the card offers Request access and says who decides; a member cannot decide.
    const note = await waitBlocked(other, host);
    await expect(note).toContainText("The site admins can allow it.");
    await expect(note.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
    await note.getByRole("button", { name: `Request access to ${host}` }).click();
    await expect(note.getByRole("status")).toContainText("site admins were notified", {
      timeout: SHELL_TIMEOUT_MS,
    });
    const asked = await pageApi<{ requests?: SiteRequest[] }>(
      page,
      "GET",
      "/v1/site/egress-ceiling/requests?status=pending",
    );
    expect((asked.json.requests ?? []).some((r) => r.domain === host)).toBe(true);

    // (b) the site admin approves with the exact host (the select's first choice) in the console.
    await page.goto("/admin/site/egress");
    const pending = page.getByRole("table", { name: /^Pending site requests/ });
    await expect(pending).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
    const row = pending.getByRole("row").filter({ hasText: host });
    await expect(row.getByRole("combobox", { name: `Pattern to enable for ${host}` })).toHaveValue(
      host,
    );
    await row.getByRole("button", { name: new RegExp(`^Approve ${host} for `) }).click();
    await expect(row).toHaveCount(0, { timeout: SHELL_TIMEOUT_MS });
    expect((await ceiling(page)).find((d) => d.domain === host)?.in_ceiling).toBe(true);

    // member2's card shows the approval through its poll.
    await expect(note.getByRole("status")).toContainText(`enabled ${host}`, {
      timeout: DECISION_TIMEOUT_MS,
    });
    await expect(note.getByRole("status")).toContainText("Ask the agent to try again.");

    // The first answer's curl never reached the host; the retry does, with no new notice.
    expect(await curlCode(otherChat.answers.first())).toBe(NOT_REACHED);
    const shown = await blockedNote(other, host).count();
    const again = await retry(otherChat, host);
    expect(again.code).not.toBe(NOT_REACHED);
    expect(again.notices).toBe(shown);
  } finally {
    await otherChat.trashAll().catch((e: unknown) => console.warn(`trash failed: ${String(e)}`));
    await other.context().close();
    await cleanUp(page, host, before);
  }
});

test("internal host: forbidden_address, the site admin approves Internal (same cluster) in the card, the retry reaches it", async ({
  chat,
  page,
}) => {
  test.skip(!INTERNAL_HOST, "KOBE_EGRESS_INTERNAL_HOST names a host on the cluster ingress");
  const host = INTERNAL_HOST as string;
  await chat.open();
  const before = await prepare(page, host);
  try {
    // Allowlisted but not internal: the name resolves to the ingress, which is refused.
    await allowlist(page, host);
    await chat.ask(curlTurn(host));
    const note = await waitBlocked(page, host);

    // The site admin's card: the checkbox is checked for forbidden_address.
    const decide = note.getByRole("group", { name: `Decide access to ${host}` });
    await expect(decide.getByRole("checkbox", { name: "Internal (same cluster)" })).toBeChecked();
    await decide.getByRole("button", { name: `Approve access to ${host}` }).click();
    await expect(note.getByRole("status")).toContainText(`Enabled ${host}`, {
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(note.getByRole("status")).toContainText("Ask the agent to try again.");
    expect((await ceiling(page)).find((d) => d.domain === host)?.internal).toBe(true);

    // The first curl never reached the host; the retry reaches it, with no new notice.
    expect(await curlCode(chat.answers.first())).toBe(NOT_REACHED);
    const shown = await blockedNote(page, host).count();
    const again = await retry(chat, host);
    expect(again.code).not.toBe(NOT_REACHED);
    expect(again.notices).toBe(shown);
  } finally {
    await chat.trashAll().catch((e: unknown) => console.warn(`trash failed: ${String(e)}`));
    await cleanUp(page, host, before);
  }
});

test("an allowlisted host that resolves to a private address and is not internal stays blocked", async ({
  chat,
  page,
}) => {
  test.skip(!PRIVATE_HOST, "KOBE_EGRESS_PRIVATE_HOST names a host resolving to a private address");
  const host = PRIVATE_HOST as string;
  await chat.open();
  const before = await prepare(page, host);
  try {
    await allowlist(page, host);
    await chat.ask(curlTurn(host));
    await waitBlocked(page, host);
    expect(await curlCode(chat.answers.first())).toBe(NOT_REACHED);
    // Blocked again: the retry's curl does not reach the host either (its notice may be folded
    // into the first one by the proxy's report window, so the code is what counts).
    const again = await retry(chat, host);
    expect(again.code).toBe(NOT_REACHED);
    expect(again.notices).toBeGreaterThanOrEqual(1);
    expect((await ceiling(page)).find((d) => d.domain === host)?.internal).not.toBe(true);
  } finally {
    await chat.trashAll().catch((e: unknown) => console.warn(`trash failed: ${String(e)}`));
    await cleanUp(page, host, before);
  }
});
