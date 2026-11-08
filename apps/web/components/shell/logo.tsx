import { inlineSafeMarkup, sizedLogoMarkup } from "../../lib/theme/inline-logo";
import styles from "./brand.module.css";

/** The logo's rendered height in CSS pixels (docs/theming.md §2). */
export const LOGO_HEIGHT_PX = 24;

/**
 * The themed logo (KOBE-562, docs/theming.md §2): the server's inline-safe variant of an SVG logo,
 * inserted into the page so its fills and strokes take `currentColor` (styles: `.themed` in
 * brand.module.css, foreground at rest, primary on the brand link's hover, accent when current).
 * Only that variant: the markup is checked again (lib/theme/inline-logo.ts) and anything else
 * renders nothing. Decorative beside the name unless given a `label`.
 */
export function Logo({
  svg,
  className,
  width,
  height = LOGO_HEIGHT_PX,
  label,
}: {
  /** The variant's markup, from `logo.inline` (never the raw upload). */
  readonly svg: string;
  readonly className?: string;
  readonly width?: number;
  readonly height?: number;
  /** The accessible name when the logo stands alone; omit it beside the name. */
  readonly label?: string;
}) {
  const markup = inlineSafeMarkup(svg);
  if (markup === null) return null;
  const classes = ["logo", styles.themed, className].filter(Boolean).join(" ");
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
  return (
    <span
      className={classes}
      data-logo="inline"
      {...a11y}
      // Safe by construction: the server's allowlisted variant, checked again above.
      dangerouslySetInnerHTML={{ __html: sizedLogoMarkup(markup, width, height) }}
    />
  );
}
