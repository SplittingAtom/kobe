/**
 * The composer's draft across the new-build banner's Reload (KOBE-487 ac-4). The banner marks the
 * reload as requested; each composer stashes its text when the page then unloads (`pagehide`,
 * so nothing is kept if the member cancels the unsaved-edits prompt) and takes it back once
 * after the reload. Kept per tab in sessionStorage; where storage is blocked the draft is lost
 * like on any reload.
 */
const KEY = "kobe.reload-drafts";

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
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  } catch {
    return {}; // blocked storage or a garbled value: nothing to restore
  }
}

function writeStash(stash: Readonly<Record<string, string>>): void {
  try {
    if (Object.keys(stash).length === 0) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, JSON.stringify(stash));
  } catch {
    // Storage blocked or full: the draft goes with the page, as on any reload.
  }
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
