/**
 * Giving focus back to a control after its action (KOBE-296 review S4), shared by the confirm
 * dialog and the row menu (KOBE-306).
 */

/** Where focus goes when the asking control is gone or disabled: the page (ConsoleMain). */
export function consoleMain(): HTMLElement | null {
  return document.getElementById("console-main");
}

/** A control that can take focus back: still on the page and not disabled. */
export function focusable(el: HTMLElement | null): boolean {
  return !!el && el.isConnected && !el.matches(":disabled");
}

/** How long a confirmed action may keep its control disabled before focus stops waiting. */
const REENABLE_WAIT_MS = 15_000;

/**
 * After a confirmed action the asking control is usually disabled while the action runs (the
 * page's pending state) and enabled again once it ends. Focus waits on `interim` (the page's
 * main) meanwhile and returns to the control when it is enabled, unless the person has moved
 * focus elsewhere or the control left the page.
 */
export function focusWhenEnabled(target: HTMLElement, interim: HTMLElement | null): void {
  if (typeof MutationObserver === "undefined") return;
  const waiting = () => {
    const active = document.activeElement;
    return active === null || active === document.body || active === interim || active === target;
  };
  const observer = new MutationObserver(() => {
    if (!target.isConnected || !waiting()) return stop();
    if (!target.matches(":disabled")) {
      target.focus();
      stop();
    }
  });
  const timer = setTimeout(() => stop(), REENABLE_WAIT_MS);
  function stop() {
    observer.disconnect();
    clearTimeout(timer);
  }
  observer.observe(target, { attributes: true, attributeFilter: ["disabled", "aria-busy"] });
}
