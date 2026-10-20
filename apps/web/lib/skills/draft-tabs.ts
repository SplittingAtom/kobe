/**
 * The Workbench draft page's tabs (KOBE-459): Define (the files and the editor), Test (the test
 * chat) and Eval (the evals and their history). The tab is in the address (`?tab=`) so a link
 * opens it, and the last one used is remembered per draft in this browser (localStorage, like the
 * artifact tabs per thread; transient state, so a blocked storage only loses the memory).
 *
 * A plain module: the page's server component reads `?tab=` with `draftTabParam`.
 */
export const DRAFT_TABS = ["define", "test", "eval"] as const;
export type DraftTab = (typeof DRAFT_TABS)[number];

const DEFAULT_TAB: DraftTab = "define";
const KEY_PREFIX = "kobe.workbench.tab.";

const isDraftTab = (v: unknown): v is DraftTab =>
  typeof v === "string" && (DRAFT_TABS as readonly string[]).includes(v);

/** The tab `?tab=` names: null without one, Define for a value that is no tab. */
export function draftTabParam(value: string | string[] | undefined): DraftTab | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (v === undefined) return null;
  return isDraftTab(v) ? v : DEFAULT_TAB;
}

/** The tab last used for this draft in this browser, if any. */
export function rememberedDraftTab(draftId: string): DraftTab | null {
  try {
    const stored = localStorage.getItem(KEY_PREFIX + draftId);
    return isDraftTab(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Remembers the tab for this draft; storage that refuses only loses the memory. */
export function rememberDraftTab(draftId: string, tab: DraftTab): void {
  try {
    localStorage.setItem(KEY_PREFIX + draftId, tab);
  } catch {
    // Private mode or blocked site data: the page still works, it just won't remember.
  }
}

/** The tab the page opens on: the address's, else the remembered one, else Define. */
export function openingDraftTab(requested: DraftTab | null, draftId: string): DraftTab {
  return requested ?? rememberedDraftTab(draftId) ?? DEFAULT_TAB;
}

/** Keeps the tab in the address (a reload or a shared link opens it), without a navigation. */
export function showDraftTabInAddress(tab: DraftTab): void {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("tab") === tab) return;
    url.searchParams.set("tab", tab);
    window.history.replaceState(window.history.state, "", url);
  } catch (err) {
    // An address that can't be rewritten only loses the link to the tab; the page still works.
    console.warn("[kobe] the draft tab could not be put in the address", err);
  }
}
