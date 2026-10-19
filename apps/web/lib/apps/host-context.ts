import { OS_DARK_QUERY, parseTheme, type Theme } from "../theme/theme";

/**
 * The `hostContext` Kobe gives an app (spec §7): Kobe's current theme and its colours as the
 * ext-apps CSS variables, the display mode, the locale and the container size. Never a user or
 * team identifier.
 */
export type Placement = "inline" | "expanded";

/** ext-apps style variable → Kobe's theme token (`app/theme.css`). */
const STYLE_TOKENS: Readonly<Record<string, string>> = {
  "--color-background-primary": "--background",
  "--color-background-secondary": "--muted",
  "--color-text-primary": "--foreground",
  "--color-text-secondary": "--muted-foreground",
  "--color-border-primary": "--border",
};

export function currentTheme(doc: Document = document): Theme {
  const chosen = parseTheme(doc.documentElement.dataset["theme"]);
  if (chosen) return chosen;
  const view = doc.defaultView;
  return view?.matchMedia?.(OS_DARK_QUERY).matches ? "dark" : "light";
}

function styleVariables(doc: Document): Record<string, string> {
  const view = doc.defaultView;
  if (!view) return {};
  const computed = view.getComputedStyle(doc.documentElement);
  const out: Record<string, string> = {};
  for (const [name, token] of Object.entries(STYLE_TOKENS)) {
    const value = computed.getPropertyValue(token).trim();
    if (value !== "") out[name] = value;
  }
  return out;
}

export function buildHostContext(
  placement: Placement,
  size: { readonly width: number; readonly maxHeight: number },
  doc: Document = document,
): Record<string, unknown> {
  return {
    theme: currentTheme(doc),
    styles: { variables: styleVariables(doc) },
    displayMode: placement === "expanded" ? "fullscreen" : "inline",
    locale: doc.defaultView?.navigator.language ?? "en",
    containerDimensions: { width: Math.round(size.width), maxHeight: size.maxHeight },
  };
}
