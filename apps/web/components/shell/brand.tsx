"use client";

import { useEffect, useState } from "react";
import { fetchInlineLogo } from "../../lib/theme/inline-logo";
import { useBranding } from "./branding-context";
import styles from "./brand.module.css";
import { LOGO_HEIGHT_PX, Logo } from "./logo";

export { LOGO_HEIGHT_PX };

/**
 * width/height attributes for a logo: scaled to {@link LOGO_HEIGHT_PX} when the server knows the
 * file's size (raster logos), so the browser reserves the space before it loads (no layout shift);
 * otherwise only the height, as before.
 */
function logoSize(width?: number, height?: number): { width?: number; height: number } {
  if (width === undefined || height === undefined) return { height: LOGO_HEIGHT_PX };
  return {
    width: Math.max(1, Math.round((width * LOGO_HEIGHT_PX) / height)),
    height: LOGO_HEIGHT_PX,
  };
}

/**
 * The inline logo's markup (KOBE-562): the server render's when it fetched it, else (the Appearance
 * preview, with branding from the admin API) fetched in the browser from `url`; null until then.
 */
function useInlineLogo(url: string | undefined, known: string | undefined): string | null {
  const [fetched, setFetched] = useState<{ url: string; markup: string | null } | null>(null);
  useEffect(() => {
    if (url === undefined || known !== undefined) return;
    let live = true;
    void fetchInlineLogo(url).then((markup) => {
      if (live) setFetched({ url, markup });
    });
    return () => {
      live = false;
    };
  }, [url, known]);
  if (url === undefined) return null;
  return known ?? (fetched?.url === url ? fetched.markup : null);
}

/**
 * The site's brand (theming plan §4.3, docs/theming.md §2): the bar's wordmark and the console
 * and My area brand links. With no logo it is the name alone, as text, exactly as before
 * branding existed. With a logo: the logo (24 px tall, ≤ 160 px wide, scaled to fit; the dark
 * logo, when there is one, in the dark theme through the --kobe-when-* tokens) and the name, which
 * stays the accessible name even when the admin hides it visually ("Show the name" off). The logo
 * is above the fold, so it decodes with the page (no `decoding="async"`). With "Logo takes the
 * theme colour" on and an SVG logo (KOBE-562), the server's inline-safe variant is inlined instead
 * (<Logo>), one drawing for both schemes in the theme's colours.
 */
export function Brand() {
  const { appName, showName, logo, logoSvg } = useBranding();
  const inline = useInlineLogo(logo?.inline, logoSvg);
  if (logo === null) return appName;
  const light = logo.dark ? `${styles.logo} ${styles.whenLight}` : styles.logo;
  const name = <span className={showName ? undefined : "sr-only"}>{appName}</span>;
  if (inline !== null) {
    return (
      <span className={styles.brand} data-brand="">
        <Logo svg={inline} {...logoSize(logo.width, logo.height)} />
        {name}
      </span>
    );
  }
  return (
    <span className={styles.brand} data-brand="">
      {/* Same-origin asset URLs (lib/theme/branding-server.ts); the name carries the meaning. */}
      <img
        src={logo.url}
        alt=""
        {...logoSize(logo.width, logo.height)}
        className={light}
        data-logo="light"
      />
      {logo.dark && (
        <img
          src={logo.dark}
          alt=""
          {...logoSize(logo.darkWidth, logo.darkHeight)}
          className={`${styles.logo} ${styles.whenDark}`}
          data-logo="dark"
        />
      )}
      {name}
    </span>
  );
}
