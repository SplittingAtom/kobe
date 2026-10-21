import type { Page } from "@playwright/test";

/**
 * The nonce CSP drops un-nonced injected `<style>` (KOBE-469); specs assert none was reported.
 * Collects the page's style-src CSP violations from now on (client-side navigation keeps it). */
export async function watchStyleViolations(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { kobeStyleViolations: string[] }).kobeStyleViolations = seen;
    document.addEventListener("securitypolicyviolation", (e) => {
      if (e.effectiveDirective.startsWith("style-src")) {
        seen.push(`${e.effectiveDirective} ${e.blockedURI} ${e.sample}`);
      }
    });
  });
}

/** The style-src violations seen since `watchStyleViolations`. */
export async function styleViolations(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { kobeStyleViolations: string[] }).kobeStyleViolations,
  );
}
