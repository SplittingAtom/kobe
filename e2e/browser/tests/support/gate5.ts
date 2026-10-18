import { expect, type Browser, type Locator, type Page } from "@playwright/test";
import { RUN_TIMEOUT_MS, SHELL_TIMEOUT_MS } from "./constants.js";

/**
 * Helpers for the Gate 5 story checks (KOBE-227, `tests/gate5/`) and the specs they reuse. CI's
 * k3d install answers with the scripted fake model (`KOBE_FAKE_MODEL=1`,
 * services/model-gateway/src/testing/fake-llm.ts): it echoes prompts, runs `bash: <command>` and
 * `tool: <name> <json>`, streams `kobe-long-answer=<n>` slowly and reports `kobe-prompt-tokens=<n>`.
 * Against a real model the same checks send plain instructions.
 */
export const FAKE_MODEL = process.env["KOBE_FAKE_MODEL"] === "1";

/** A run that streams for a while (about 25 s with the fake): long enough to scroll, queue, stop. */
export function longAnswer(real: string): string {
  return FAKE_MODEL ? "kobe-long-answer=400 a long answer" : real;
}

/** A turn whose first step runs `command` with the bash tool. */
export function bashTurn(command: string): string {
  return FAKE_MODEL
    ? `bash: ${command}`
    : `Use the bash tool to run exactly this command, once, then reply with the single word OK: ${command}`;
}

/** A turn that calls `tool` once with `args`. */
export function toolTurn(tool: string, args: Record<string, unknown>): string {
  return FAKE_MODEL
    ? `tool: ${tool} ${JSON.stringify(args)}`
    : `Call the ${tool} tool exactly once with exactly these arguments (JSON): ${JSON.stringify(args)}. Then reply DONE.`;
}

/** The team the chat recorded, for API calls made from the page. */
const TEAM_KEY = "kobe.lastTeamId";

/** A JSON API call from the page (session cookie, CSRF Origin, the active team). */
export async function pageApi<T = Record<string, unknown>>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  return page.evaluate(
    async ({ method, path, body, teamKey }) => {
      const team = window.localStorage.getItem(teamKey);
      const headers: Record<string, string> = team ? { "x-kobe-team": team } : {};
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
        // not JSON
      }
      return { status: res.status, json: json as T };
    },
    { method, path, body, teamKey: TEAM_KEY },
  );
}

/** The member's stored layout (`GET /v1/me/preferences`). */
export async function preferences(page: Page): Promise<Record<string, unknown>> {
  const r = await pageApi<{ preferences?: Record<string, unknown> }>(
    page,
    "GET",
    "/v1/me/preferences",
  );
  return r.json.preferences ?? {};
}

/** Puts preference keys back (`PUT /v1/me/preferences`), e.g. what a test changed. */
export async function putPreferences(page: Page, values: Record<string, unknown>): Promise<void> {
  await pageApi(page, "PUT", "/v1/me/preferences", values);
}

/** Uploads a small text file into the member's workspace; returns the status. */
export async function workspaceFile(page: Page, path: string, text: string): Promise<number> {
  return page.evaluate(
    async ({ path, text, teamKey }) => {
      const team = window.localStorage.getItem(teamKey);
      const headers: Record<string, string> = team ? { "x-kobe-team": team } : {};
      const slash = path.lastIndexOf("/");
      const form = new FormData();
      form.set("path", slash < 0 ? "" : path.slice(0, slash));
      form.set("file", new File([text], path.slice(slash + 1), { type: "text/plain" }));
      return (await fetch("/v1/workspace/files", { method: "POST", headers, body: form })).status;
    },
    { path, text, teamKey: TEAM_KEY },
  );
}

/** Deletes a workspace path (file or folder). */
export async function deleteWorkspacePath(page: Page, path: string): Promise<number> {
  return (await pageApi(page, "DELETE", `/v1/workspace/files?path=${encodeURIComponent(path)}`))
    .status;
}

/**
 * A second browser for the same member (another device): a fresh context that signs in with the
 * password, not a copy of the first one's session.
 */
export async function secondBrowser(
  browser: Browser,
  user = process.env["KOBE_USER"],
  password = process.env["KOBE_PW"],
): Promise<Page> {
  if (!user || !password) throw new Error("KOBE_USER and KOBE_PW are required");
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(user);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), {
    timeout: SHELL_TIMEOUT_MS,
  });
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({
    timeout: SHELL_TIMEOUT_MS,
  });
  return page;
}

/** The three workspace regions under the bar (CE5–CE7). */
export function regions(page: Page): { rail: Locator; artifact: Locator; conversation: Locator } {
  return {
    rail: page.locator('[data-shell-region="rail"]'),
    artifact: page.locator('[data-shell-region="artifact"]'),
    conversation: page.locator('[data-shell-region="conversation"]'),
  };
}

export const widthOf = async (l: Locator): Promise<number> => (await l.boundingBox())?.width ?? 0;

/** Answers the newest approval card with Allow (a write tool asks first). */
export async function allowApproval(page: Page): Promise<void> {
  const card = page.getByRole("group", { name: /Approval needed/ }).last();
  await expect(card).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  await card.getByRole("button", { name: "Allow", exact: true }).click();
}

/** A product failure filed and not fixed yet: the check runs, expected to fail (not when strict). */
export const EXPECTED_FAILURES = process.env["KOBE_GATE_STRICT"] !== "1";
