/** Marks the bar's disclosure menus (team switcher, profile menu); at most one is open. */
const MENU_ATTR = "data-bar-menu";
const PORTALLED = "[data-radix-popper-content-wrapper]";

/**
 * Callback ref for a `<details>` menu in the bar (KOBE-197): a click outside and Escape close it,
 * and opening it closes the other bar menus. Spread `barMenuProps` on the element.
 */
export function barMenuRef(el: HTMLDetailsElement | null): (() => void) | undefined {
  if (el === null) return undefined;
  const onPointerDown = (e: PointerEvent) => {
    const target = e.target as Node;
    // A picker's popover inside the menu portals to the body; pressing it stays in the menu.
    const portalled = target instanceof Element && target.closest(PORTALLED) !== null;
    if (el.open && !el.contains(target) && !portalled) el.open = false;
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !el.open) return;
    e.stopPropagation();
    el.open = false;
    el.querySelector("summary")?.focus();
  };
  const onToggle = () => {
    if (!el.open) return;
    for (const other of document.querySelectorAll<HTMLDetailsElement>(`details[${MENU_ATTR}]`)) {
      // A menu inside another (the profile menu in the one-row bar's menu) keeps its parent open.
      if (other !== el && !other.contains(el)) other.open = false;
    }
  };
  document.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("toggle", onToggle);
  return () => {
    document.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("keydown", onKeyDown);
    el.removeEventListener("toggle", onToggle);
  };
}

export const barMenuProps = { [MENU_ATTR]: "", ref: barMenuRef } as const;
