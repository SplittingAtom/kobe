import { APP_CONTEXT_PREAMBLE, type AppContextPart } from "@kobe/protocol";
import type { KobeDb } from "@kobe/db";
import { memberApps } from "./catalog.js";

/**
 * MCP Apps model context (KOBE-439, spec §8, MA7, T8): the chips a member sends with a message
 * reach Pi as fenced, untrusted data in front of the member's own text, after one fixed sentence.
 * The block is part of the run's input, so Pi's user entry, the thread's history and exports
 * carry exactly what was sent. Only parts naming an app the member can open now, with the same
 * approved template, are accepted; nothing an app sends ever goes to the model without the
 * member's send.
 */
export { APP_CONTEXT_PREAMBLE };

export interface ResolvedAppContext {
  /** The app's connector (KOBE-451 review LOW-5: refused where the thread has it off). */
  readonly connectorId?: string;
  readonly connectorName: string;
  readonly data: AppContextPart["data"];
}

/** Format, bidi and line/paragraph separator characters (review LOW-I). */
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}]/gu;

const escape = (c: string) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;

/**
 * Compact JSON that cannot close the fence or open markup (`<`, `>`, `&` as escapes), and whose
 * invisible and bidi characters are escaped too, so what Pi reads is what history shows.
 */
function fencedJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&]/g, escape).replace(INVISIBLE, escape);
}

/** An attribute value: no quotes, angle brackets or ampersands. */
function attribute(value: string): string {
  return value.replace(/[^\p{L}\p{N} ._:/-]/gu, "_").slice(0, 120);
}

export function appContextBlock(context: ResolvedAppContext): string {
  return (
    `<app-context source="connector:${attribute(context.connectorName)}" untrusted="true">\n` +
    `${fencedJson(context.data)}\n</app-context>`
  );
}

/** The run's input: the preamble and the blocks, then the member's text. */
export function withAppContext(contexts: readonly ResolvedAppContext[], text: string): string {
  if (contexts.length === 0) return text;
  return `${APP_CONTEXT_PREAMBLE}\n${contexts.map(appContextBlock).join("\n")}\n\n${text}`;
}

/** Each part, if it names a live app of the member with the same template; else undefined. */
export async function resolveAppContexts(
  db: KobeDb,
  teamId: string,
  userId: string,
  parts: readonly AppContextPart[],
): Promise<ResolvedAppContext[] | undefined> {
  if (parts.length === 0) return [];
  const apps = new Map((await memberApps(db, teamId, userId)).map((a) => [a.appId, a] as const));
  const resolved: ResolvedAppContext[] = [];
  for (const part of parts) {
    const app = apps.get(part.app_id);
    if (!app || app.connector.id !== part.connector_id || app.sha256 !== part.template_sha256) {
      return undefined;
    }
    resolved.push({
      connectorId: app.connector.id,
      connectorName: app.connector.name,
      data: part.data,
    });
  }
  return resolved;
}
