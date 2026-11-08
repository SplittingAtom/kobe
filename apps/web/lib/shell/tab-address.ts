/**
 * Keeps a page's open tab in the address (`?tab=`), so a reload or a copied link opens it, without
 * a navigation (`history.replaceState`, which Next's router follows). Shared by the Skills page
 * (KOBE-321) and the Agents page (KOBE-569). An address that can't be rewritten only loses the
 * link to the tab: the page still works.
 */
export function showTabInAddress(tab: string): void {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("tab") === tab) return;
    url.searchParams.set("tab", tab);
    window.history.replaceState(window.history.state, "", url);
  } catch (err) {
    console.warn("[kobe] the open tab could not be put in the address", err);
  }
}
