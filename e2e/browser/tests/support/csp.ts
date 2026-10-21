import type { Page } from "@playwright/test";

/**
 * The nonce CSP drops un-nonced injected `<style>` (KOBE-469); specs assert none was reported.
 * Collects the page's style-src CSP violations from now on (client-side navigation keeps it).
 * Each report names what is known of the source: the directive, the blocked URI, the sample
 * (empty unless the CSP has 'report-sample'), the script location that caused it, and the
 * opening of any un-nonced `<style>` added to the document since (a violation from a
 * DOMParser or other detached document has no element here; KOBE-465).
 */
export async function watchStyleViolations(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    const unnonced: string[] = [];
    const w = window as unknown as { kobeStyleViolations: string[]; kobeUnnoncedStyles: string[] };
    w.kobeStyleViolations = seen;
    w.kobeUnnoncedStyles = unnonced;
    new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (node instanceof HTMLStyleElement && !node.nonce) {
            unnonced.push((node.textContent ?? "").slice(0, 120));
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
    document.addEventListener("securitypolicyviolation", (e) => {
      if (!e.effectiveDirective.startsWith("style-src")) return;
      const where = e.sourceFile ? ` at ${e.sourceFile}:${e.lineNumber}:${e.columnNumber}` : "";
      const sample = e.sample ? ` sample=${JSON.stringify(e.sample)}` : "";
      const element =
        unnonced.length > 0 ? ` latest un-nonced <style>=${JSON.stringify(unnonced.at(-1))}` : "";
      seen.push(`${e.effectiveDirective} ${e.blockedURI}${sample}${where}${element}`);
    });
  });
}

/** The style-src violations seen since `watchStyleViolations`. */
export async function styleViolations(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { kobeStyleViolations: string[] }).kobeStyleViolations,
  );
}
