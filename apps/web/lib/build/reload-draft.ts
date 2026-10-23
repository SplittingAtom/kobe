/**
 * The composer's draft across the new-build banner's Reload (KOBE-487 ac-4). The banner marks the
 * reload as requested; each composer stashes its text when the page then unloads (`pagehide`,
 * so nothing is kept if the member cancels the unsaved-edits prompt) and takes it back once
 * after the reload. Kept per tab in sessionStorage; where storage is blocked the draft is lost
 * like on any reload. The stash lasts {@link RELOAD_DRAFT_TTL_MS} and sign-out clears it, so a
 * person signing in on the same tab later never gets another's draft.
 */
const KEY = "kobe.reload-drafts";
/** A reload takes seconds; anything older is not from the banner's Reload. */
export const RELOAD_DRAFT_TTL_MS = 10 * 60_000;

interface Stash {
  readonly savedAt: number;
  readonly drafts: Readonly<Record<string, string>>;
}

let reloadRequested = false;

export function requestReload(): void {
  reloadRequested = true;
}

export function isReloadRequested(): boolean {
  return reloadRequested;
}

/** For tests. */
export function resetReloadRequest(): void {
  reloadRequested = false;
}

function readStash(): Readonly<Record<string, string>> {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as Partial<Stash> | null;
    const savedAt = parsed?.savedAt;
    const drafts: unknown = parsed?.drafts;
    if (typeof savedAt !== "number" || typeof drafts !== "object" || drafts === null) return {};
    const age = Date.now() - savedAt;
    if (age < 0 || age > RELOAD_DRAFT_TTL_MS) {
      sessionStorage.removeItem(KEY);
      return {};
    }
    return Object.fromEntries(
      Object.entries(drafts).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  } catch {
    return {}; // blocked storage or a garbled value: nothing to restore
  }
}

function writeStash(drafts: Readonly<Record<string, string>>): void {
  try {
    if (Object.keys(drafts).length === 0) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, JSON.stringify({ savedAt: Date.now(), drafts }));
  } catch {
    // Storage blocked or full: the draft goes with the page, as on any reload.
  }
}

/** Drops every kept draft (sign-out). */
export function forgetReloadDrafts(): void {
  writeStash({});
}

/** Keeps `text` for the composer of `draftKey` when the banner's Reload unloads the page. */
export function stashDraftForReload(draftKey: string, text: string): void {
  if (!reloadRequested || text.trim() === "") return;
  writeStash({ ...readStash(), [draftKey]: text });
}

/** The draft kept for `draftKey` by the last Reload, once. */
export function takeReloadDraft(draftKey: string): string | undefined {
  const stash = readStash();
  const text = stash[draftKey];
  if (text === undefined) return undefined;
  writeStash(Object.fromEntries(Object.entries(stash).filter(([k]) => k !== draftKey)));
  return text;
}
