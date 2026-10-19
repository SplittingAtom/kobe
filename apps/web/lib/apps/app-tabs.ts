import type { AppFrameApp } from "../../components/apps/app-frame";

/**
 * An app expanded into the artifact column (KOBE-438, spec MA3): a transient tab of kind `app`,
 * `app:<card key>`. Not an artifact: no versions, nothing stored, never remembered across reloads.
 */
const PREFIX = "app:";

export const appTabId = (cardKey: string): string => `${PREFIX}${cardKey}`;

export const isAppTab = (id: string): boolean => id.startsWith(PREFIX);

/** What the expanded frame needs: the card's app, input and stored result. */
export interface AppTabSpec {
  readonly cardKey: string;
  readonly app: AppFrameApp;
  readonly toolInput?: Record<string, unknown> | undefined;
  readonly toolResult: Record<string, unknown>;
}
